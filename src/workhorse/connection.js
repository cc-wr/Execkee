import WebSocket from 'ws';
import { MSG, parseMessage, makeMessage } from '../common/protocol.js';
import config from '../common/config.js';

export class ServerConnection {
  constructor({ serverUrl, workhorseId, workhorseName, os, onCommand, onSync, onSettings }) {
    this.serverUrl = serverUrl;
    this.workhorseId = workhorseId;
    this.workhorseName = workhorseName;
    this.os = os;
    this.onCommand = onCommand || (() => {});
    this.onSync = onSync || (() => {});
    this.onSettings = onSettings || (() => {});
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
  }

  connect() {
    console.log(`[connection] Connecting to ${this.serverUrl}...`);

    this.ws = new WebSocket(this.serverUrl);

    this.ws.on('open', () => {
      console.log('[connection] Connected to server');
      this.connected = true;

      this.ws.send(makeMessage(MSG.REGISTER, {
        workhorseId: this.workhorseId,
        name: this.workhorseName,
        os: this.os,
      }));
      // Ask the controller for our authoritative roster (works on first connect
      // AND reconnect — we never read the controller's disk).
      this.ws.send(makeMessage(MSG.SYNC_REQUEST, {
        workhorseId: this.workhorseId,
        reason: 'startup',
      }));
    });

    this.ws.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg) return;

      switch (msg.type) {
        case MSG.COMMAND:
          this._handleCommand(msg);
          break;
        case MSG.SYNC:
          console.log(`[connection] Received SYNC: ${(msg.instances || []).length} instance(s)`);
          this.onSync(msg.instances || [], msg.mode);
          break;
        case MSG.SETTINGS_PUSH:
          this.onSettings(msg);
          break;
        case MSG.PING:
          this.ws.send(makeMessage(MSG.PONG));
          break;
        default:
          break;
      }
    });

    this.ws.on('close', () => {
      console.log('[connection] Disconnected from server');
      this.connected = false;
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[connection] WebSocket error:', err.message);
      this.connected = false;
    });
  }

  sendStateUpdate(instances) {
    if (!this.connected) return;
    this.ws.send(makeMessage(MSG.STATE_UPDATE, {
      workhorseId: this.workhorseId,
      instances,
    }));
  }

  sendReportResult({ instanceId, report, success, error, watermark, requestId }) {
    if (!this.connected) return;
    this.ws.send(makeMessage(MSG.REPORT_RESULT, {
      workhorseId: this.workhorseId,
      instanceId,
      report,
      success,
      error,
      watermark,
      requestId,
    }));
  }

  sendSessionsResult({ sessions, success, error, requestId }) {
    if (!this.connected) return;
    this.ws.send(makeMessage(MSG.SESSIONS_RESULT, {
      workhorseId: this.workhorseId,
      sessions,
      success,
      error,
      requestId,
    }));
  }

  sendEvent({ instanceId, event }) {
    if (!this.connected) return;
    this.ws.send(makeMessage(MSG.EVENT, {
      workhorseId: this.workhorseId,
      instanceId,
      event,
    }));
  }

  async _handleCommand(msg) {
    try {
      const result = await this.onCommand(msg);
      if (msg.requestId) {
        this.ws.send(makeMessage(MSG.ACK, {
          requestId: msg.requestId,
          success: result?.success !== false,
          error: result?.error,
        }));
      }
    } catch (err) {
      console.error(`[connection] Command error:`, err.message);
      if (msg.requestId) {
        this.ws.send(makeMessage(MSG.ACK, {
          requestId: msg.requestId,
          success: false,
          error: err.message,
        }));
      }
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, config.RECONNECT_INTERVAL_MS);
    console.log(`[connection] Reconnecting in ${config.RECONNECT_INTERVAL_MS / 1000}s...`);
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}
