export const MSG = Object.freeze({
  REGISTER: 'register',
  STATE_UPDATE: 'state-update',
  REPORT_RESULT: 'report-result',
  EVENT: 'event',
  COMMAND: 'command',
  SETTINGS_PUSH: 'settings-push',
  ACK: 'ack',
  PING: 'ping',
  PONG: 'pong',
});

export const CMD = Object.freeze({
  FOREGROUND: 'foreground',
  HIDE: 'hide',
  REPORT: 'report',
  CLOSE: 'close',
  CREATE: 'create',
  MANAGE: 'manage',
  UNMANAGE: 'unmanage',
});

export const DESIRED_STATE = Object.freeze({
  ALIVE: 'alive',
  CLOSING: 'closing',
  CLOSED: 'closed',
  FAILED: 'failed',
});

export const VISIBILITY = Object.freeze({
  FOREGROUND: 'foreground',
  HIDDEN: 'hidden',
});

let _reqCounter = 0;

export function makeMessage(type, payload = {}) {
  return JSON.stringify({
    type,
    requestId: `req-${++_reqCounter}`,
    ts: new Date().toISOString(),
    ...payload,
  });
}

export function parseMessage(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
