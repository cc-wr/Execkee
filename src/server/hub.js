import { WebSocketServer } from 'ws';
import { MSG, CMD, parseMessage, makeMessage } from '../common/protocol.js';
import { readTracking, writeTracking, registerWorkhorse, getInstancesForWorkhorse } from '../common/tracking.js';
import { writeState } from '../common/store.js';
import config from '../common/config.js';

export class Hub {
  constructor({ port, onDashboardUpdate }) {
    this.port = port;
    this.onDashboardUpdate = onDashboardUpdate || (() => {});
    this.wss = null;
    this.connections = new Map();
    this.liveState = {};
    this.pendingCallbacks = new Map();
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
            break;

          case MSG.STATE_UPDATE:
            this._handleStateUpdate(msg);
            break;

          case MSG.REPORT_RESULT:
            this._handleReportResult(msg);
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
    const interval = setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(makeMessage(MSG.PING));
      } else {
        clearInterval(interval);
      }
    }, config.HEARTBEAT_INTERVAL_MS);
    ws.on('close', () => clearInterval(interval));
  }

  stop() {
    if (this.wss) this.wss.close();
  }
}
