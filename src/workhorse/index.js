import { platform, hostname } from 'os';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import config from '../common/config.js';
import { CMD } from '../common/protocol.js';
import { ServerConnection } from './connection.js';
import { InstanceManager } from './instances.js';

function loadConfig() {
  const configPath = join(config.DATA_DIR, 'workhorse-config.json');
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {}
  }
  return {};
}

const saved = loadConfig();
const serverUrl = process.argv[2] || saved.serverUrl || `ws://localhost:${config.WS_PORT}`;
const workhorseId = process.argv[3] || saved.workhorseId || `wh-${hostname().toLowerCase()}`;
const workhorseName = process.argv[4] || saved.name || hostname();

console.log(`[workhorse] Starting subcontroller: ${workhorseId}`);
console.log(`[workhorse] Server: ${serverUrl}`);

const instanceManager = new InstanceManager({
  workhorseId,
  onEvent: (event) => {
    connection.sendEvent({ instanceId: event.instanceId, event });
  },
});

const connection = new ServerConnection({
  serverUrl,
  workhorseId,
  workhorseName,
  os: platform(),
  onCommand: async (msg) => {
    console.log(`[workhorse] Command: ${msg.command} for ${msg.instanceId || 'N/A'}`);

    switch (msg.command) {
      case CMD.FOREGROUND:
        return instanceManager.foreground(msg.instanceId);

      case CMD.HIDE:
        return instanceManager.hide(msg.instanceId);

      case CMD.REPORT: {
        const result = await instanceManager.report(msg.instanceId);
        connection.sendReportResult({
          instanceId: msg.instanceId,
          report: result.report,
          success: result.success,
          error: result.error,
          watermark: result.watermark,
          requestId: msg.requestId,
        });
        return result;
      }

      case CMD.CLOSE:
        return instanceManager.close(msg.instanceId);

      case CMD.CREATE:
        return { success: true, instance: instanceManager.createInstance(msg) };

      case CMD.MANAGE:
        return { success: true, instance: instanceManager.manageExisting(msg) };

      case CMD.UNMANAGE:
        return instanceManager.unmanage(msg.instanceId);

      default:
        return { success: false, error: `Unknown command: ${msg.command}` };
    }
  },
});

connection.connect();
instanceManager.startAll();

const stateInterval = setInterval(() => {
  const state = instanceManager.getLocalState();
  connection.sendStateUpdate(state);
}, 10_000);

function shutdown() {
  console.log('[workhorse] Shutting down...');
  clearInterval(stateInterval);
  instanceManager.stopAll();
  connection.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('[workhorse] Subcontroller ready.');
