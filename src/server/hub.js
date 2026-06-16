import { WebSocketServer } from 'ws';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { MSG, CMD, parseMessage, makeMessage, maxDesiredState } from '../common/protocol.js';
import { readTracking, writeTracking, registerWorkhorse, getInstancesForWorkhorse, createInstanceRecord } from '../common/tracking.js';
import { writeState } from '../common/store.js';
import { hashOf } from '../common/settings-sync.js';
import config from '../common/config.js';

// Fields a workhorse is the source of truth for — folded from STATE_UPDATE into
// the controller's master tracking (§2.3). Controller-owned identity fields
// (id/name/sessionId/workhorseId/createdAt) are never overwritten from the wire.
const WH_OWNED = ['pid', 'windowHandle', 'visibility', 'externallyHeld', 'crashCount',
  'heldBySubcontroller', 'watermark', 'lastReportTime', 'lastReportContent',
  'reportFailureCount', 'lastReportError', 'lastActivityTime', 'skipPermissions'];

export class Hub {
  constructor({ port, onDashboardUpdate }) {
    this.port = port;
    this.onDashboardUpdate = onDashboardUpdate || (() => {});
    this.wss = null;
    this.connections = new Map();
    this.liveState = {};
    this.pendingCallbacks = new Map();
    // Canonical Claude-settings store (settings sync). { [name]: {content, mtime, hash, origin} }.
    // Set by index.js to apply an accepted change to the controller's OWN machine.
    this.canonicalSettings = this._loadCanonical();
    this.onSettingsAccepted = () => {};
  }

  start() {
    this.wss = new WebSocketServer({ port: this.port });
    console.log(`[hub] WebSocket server listening on port ${this.port}`);

    this.wss.on('connection', (ws) => {
      let workhorseId = null;

      ws.on('message', (raw) => {
        const msg = parseMessage(raw.toString());
        if (!msg) return;

        switch (msg.type) {
          case MSG.REGISTER:
            workhorseId = msg.workhorseId;
            this.connections.set(workhorseId, ws);
            this._handleRegister(msg);
            console.log(`[hub] Workhorse registered: ${workhorseId}`);
            // Converge the freshly-connected workhorse toward the canonical settings;
            // it will also report its own, and the newer (by mtime) wins.
            this.pushSettingsTo(workhorseId);
            break;

          case MSG.STATE_UPDATE:
            this._handleStateUpdate(msg);
            break;

          case MSG.SYNC_REQUEST:
            this._sendSync(msg.workhorseId || workhorseId);
            break;

          case MSG.REPORT_RESULT:
            this._handleReportResult(msg);
            break;

          case MSG.SESSIONS_RESULT:
            this._handleSessionsResult(msg);
            break;

          case MSG.SETTINGS_REPORT:
            this.ingestSettings({
              name: msg.name, content: msg.content, mtime: msg.mtime,
              hash: msg.hash, origin: msg.workhorseId || workhorseId,
            });
            break;

          case MSG.EVENT:
            this._handleEvent(msg);
            break;

          case MSG.ACK: {
            const cb = this.pendingCallbacks.get(msg.requestId);
            if (cb) {
              this.pendingCallbacks.delete(msg.requestId);
              cb({ success: msg.success, error: msg.error });
            }
            break;
          }

          case MSG.PONG:
            ws._lastPong = Date.now();
            break;

          default:
            console.log(`[hub] Unknown message type: ${msg.type}`);
        }
      });

      ws.on('close', () => {
        if (workhorseId) {
          console.log(`[hub] Workhorse disconnected: ${workhorseId}`);
          this.connections.delete(workhorseId);
          this._markWorkhorseOffline(workhorseId);
        }
      });

      ws.on('error', (err) => {
        console.error(`[hub] WebSocket error for ${workhorseId || 'unknown'}:`, err.message);
      });

      this._startHeartbeat(ws);
    });
  }

  sendCommand(workhorseId, command, params = {}) {
    const ws = this.connections.get(workhorseId);
    if (!ws || ws.readyState !== 1) {
      return { success: false, error: `Workhorse ${workhorseId} not connected` };
    }
    const msg = makeMessage(MSG.COMMAND, { command, ...params });
    ws.send(msg);

    return new Promise((resolve) => {
      const parsed = JSON.parse(msg);
      this.pendingCallbacks.set(parsed.requestId, resolve);
      setTimeout(() => {
        if (this.pendingCallbacks.has(parsed.requestId)) {
          this.pendingCallbacks.delete(parsed.requestId);
          resolve({ success: false, error: 'Timeout' });
        }
      }, 30_000);
    });
  }

  getConnectedWorkhorses() {
    return Array.from(this.connections.keys());
  }

  getLiveState() {
    return { ...this.liveState };
  }

  queryState() {
    const tracking = readTracking();
    const connected = this.getConnectedWorkhorses();
    return {
      workhorses: Object.values(tracking.workhorses).map(wh => ({
        ...wh,
        connected: connected.includes(wh.id),
      })),
      instances: Object.values(tracking.instances),
    };
  }

  // Remove an instance from the master tracking (un-adopt: the workhorse drops it
  // locally and stops monitoring; this clears it from status/dashboard).
  forgetInstance(instanceId) {
    const tracking = readTracking();
    if (tracking.instances[instanceId]) {
      delete tracking.instances[instanceId];
      writeTracking(tracking);
      return true;
    }
    return false;
  }

  // ---- Settings sync (bidirectional Claude settings) ----------------------

  _loadCanonical() {
    try {
      if (existsSync(config.SETTINGS_SYNC_FILE)) {
        return JSON.parse(readFileSync(config.SETTINGS_SYNC_FILE, 'utf-8')) || {};
      }
    } catch (err) { console.error('[hub] load canonical settings failed:', err.message); }
    return {};
  }

  _saveCanonical() {
    try {
      writeFileSync(config.SETTINGS_SYNC_FILE, JSON.stringify(this.canonicalSettings, null, 2), 'utf-8');
    } catch (err) { console.error('[hub] save canonical settings failed:', err.message); }
  }

  // Single chokepoint for every settings change (from a workhorse OR the
  // controller's own machine). Last-write-wins by mtime; only when content
  // actually differs. On accept: persist, apply to the controller's own machine
  // (when the change came from elsewhere), and rebroadcast to the other workhorses.
  ingestSettings({ name, content, mtime, hash, origin }) {
    if (!config.SETTINGS_SYNC_ENABLED) return false;
    if (!name || typeof content !== 'string') return false;
    const h = hash || hashOf(content);
    const cur = this.canonicalSettings[name];
    if (cur && cur.hash === h) return false;                 // no real change
    if (cur && !(mtime >= cur.mtime)) return false;          // stale (older than canonical)
    this.canonicalSettings[name] = { content, mtime, hash: h, origin };
    this._saveCanonical();
    console.log(`[hub] settings '${name}' updated from ${origin} (${content.length} bytes)`);
    if (origin !== 'controller-local') {
      try { this.onSettingsAccepted({ name, content, mtime, hash: h, origin }); }
      catch (err) { console.error('[hub] onSettingsAccepted error:', err.message); }
    }
    this.broadcastSettings(name, origin);
    return true;
  }

  // Send the whole canonical set to one workhorse (on connect).
  pushSettingsTo(workhorseId) {
    if (!config.SETTINGS_SYNC_ENABLED) return;
    const ws = this.connections.get(workhorseId);
    if (!ws || ws.readyState !== 1) return;
    for (const [name, rec] of Object.entries(this.canonicalSettings)) {
      ws.send(makeMessage(MSG.SETTINGS_PUSH, { name, content: rec.content, mtime: rec.mtime }));
    }
  }

  // Push one updated file to every connected workhorse except the origin.
  broadcastSettings(name, exceptId) {
    const rec = this.canonicalSettings[name];
    if (!rec) return;
    for (const [wid, ws] of this.connections) {
      if (wid === exceptId || ws.readyState !== 1) continue;
      ws.send(makeMessage(MSG.SETTINGS_PUSH, { name, content: rec.content, mtime: rec.mtime }));
    }
  }

  // Push a workhorse its authoritative roster (its own instances) from the
  // master tracking, so it can resume/launch them without reading our disk.
  _sendSync(workhorseId) {
    if (!workhorseId) return;
    const ws = this.connections.get(workhorseId);
    if (!ws || ws.readyState !== 1) return;
    const tracking = readTracking();
    const instances = getInstancesForWorkhorse(tracking, workhorseId);
    ws.send(makeMessage(MSG.SYNC, { mode: 'full', instances }));
    console.log(`[hub] Sent SYNC to ${workhorseId}: ${instances.length} instance(s)`);
  }

  _handleRegister(msg) {
    const tracking = readTracking();
    registerWorkhorse(tracking, {
      id: msg.workhorseId,
      name: msg.name,
      os: msg.os,
    });
    writeTracking(tracking);

    this.liveState[msg.workhorseId] = {
      id: msg.workhorseId,
      connected: true,
      lastSeen: new Date().toISOString(),
      instances: {},
    };
    this._persistState();
  }

  _handleStateUpdate(msg) {
    if (!this.liveState[msg.workhorseId]) {
      this.liveState[msg.workhorseId] = {
        id: msg.workhorseId,
        connected: true,
        instances: {},
      };
    }
    const wh = this.liveState[msg.workhorseId];
    wh.lastSeen = new Date().toISOString();
    wh.instances = {};
    for (const inst of (msg.instances || [])) {
      wh.instances[inst.id] = inst;
    }
    this._persistState();

    // Fold the reported state into the MASTER tracking file (§2.3) so the cowork
    // cycle, dashboard, and CLI see instances on remote workhorses without a
    // shared filesystem. Single-writer-per-fact: workhorse-owned fields overwrite;
    // identity fields are kept; desiredState only advances toward terminal.
    const tracking = readTracking();
    let changed = false;
    for (const r of (msg.instances || [])) {
      if (!r.id) continue;
      let cur = tracking.instances[r.id];
      if (!cur) {
        // New instance created on the workhorse — adopt it into the master.
        cur = createInstanceRecord({
          id: r.id,
          workhorseId: msg.workhorseId,
          name: r.name,
          projectPath: r.projectPath,
          sessionId: r.sessionId,
          visibility: r.visibility,
        });
        tracking.instances[r.id] = cur;
      }
      for (const f of WH_OWNED) {
        if (r[f] !== undefined) cur[f] = r[f];
      }
      // KI-1: first-write-wins for sessionId. A created instance starts with no
      // session id; the workhorse discovers the real one and reports it. Adopt it
      // only when the master has none — never overwrite an existing identity.
      if (!cur.sessionId && r.sessionId) cur.sessionId = r.sessionId;
      if (r.projectPath && r.projectPath !== cur.projectPath) cur.projectPath = r.projectPath;
      cur.desiredState = maxDesiredState(cur.desiredState, r.desiredState);
      changed = true;
    }
    if (changed) writeTracking(tracking);
  }

  _handleReportResult(msg) {
    console.log(`[hub] Report result for ${msg.instanceId}: ${msg.success ? 'OK' : 'FAIL'}`);

    const tracking = readTracking();
    const inst = tracking.instances[msg.instanceId];
    if (inst && msg.success) {
      inst.lastReportTime = new Date().toISOString();
      inst.lastReportContent = msg.report;
      if (msg.watermark) {
        inst.watermark = msg.watermark;
      }
      inst.heldBySubcontroller = false;
      writeTracking(tracking);
    } else if (inst) {
      inst.heldBySubcontroller = false;
      writeTracking(tracking);
    }

    const cb = this.pendingCallbacks.get(msg.requestId);
    if (cb) {
      this.pendingCallbacks.delete(msg.requestId);
      cb({ success: msg.success, report: msg.report, error: msg.error });
    }
  }

  _handleSessionsResult(msg) {
    const cb = this.pendingCallbacks.get(msg.requestId);
    if (cb) {
      this.pendingCallbacks.delete(msg.requestId);
      cb({ success: msg.success, sessions: msg.sessions || [], error: msg.error });
    }
  }

  // Ask every connected workhorse for its adoptable sessions and aggregate them,
  // tagged by workhorse and by whether they're already managed (sessionId match).
  async listSessions() {
    const connected = this.getConnectedWorkhorses();
    const tracking = readTracking();
    const managed = new Set(
      Object.values(tracking.instances).map(i => i.sessionId).filter(Boolean)
    );
    const groups = await Promise.all(connected.map(async (whId) => {
      const r = await this.sendCommand(whId, CMD.LIST_SESSIONS);
      const wh = tracking.workhorses[whId];
      const sessions = (r.sessions || []).map(s => ({ ...s, managed: managed.has(s.sessionId) }));
      return {
        workhorseId: whId,
        workhorseName: (wh && wh.name) || whId,
        error: r.success === false ? (r.error || 'list-sessions failed') : null,
        sessions,
      };
    }));
    return groups;
  }

  _handleEvent(msg) {
    console.log(`[hub] Event from ${msg.workhorseId}: ${msg.event?.type} (${msg.instanceId || 'global'})`);

    if (msg.event?.type === 'crash-recovery' || msg.event?.type === 'crash-failed') {
      const tracking = readTracking();
      const inst = tracking.instances[msg.instanceId];
      if (inst) {
        if (msg.event.type === 'crash-failed') {
          inst.desiredState = 'failed';
        }
        inst.crashCount = msg.event.crashCount || (inst.crashCount + 1);
        writeTracking(tracking);
      }
    }
  }

  _markWorkhorseOffline(workhorseId) {
    if (this.liveState[workhorseId]) {
      this.liveState[workhorseId].connected = false;
      this.liveState[workhorseId].lastSeen = new Date().toISOString();
      this._persistState();
    }
  }

  _persistState() {
    writeState({ workhorses: this.liveState });
  }

  _startHeartbeat(ws) {
    ws._lastPong = Date.now();
    const interval = setInterval(() => {
      if (ws.readyState !== 1) { clearInterval(interval); return; }
      // A clean ws 'close' isn't guaranteed on a crash or network partition, so
      // also drop a connection that has gone silent for ~3 heartbeat intervals.
      if (Date.now() - (ws._lastPong || 0) > config.HEARTBEAT_INTERVAL_MS * 3) {
        console.log('[hub] Workhorse heartbeat timed out — terminating stale connection');
        try { ws.terminate(); } catch {}
        clearInterval(interval);
        return;
      }
      ws.send(makeMessage(MSG.PING));
    }, config.HEARTBEAT_INTERVAL_MS);
    ws.on('close', () => clearInterval(interval));
  }

  stop() {
    if (this.wss) this.wss.close();
  }
}
