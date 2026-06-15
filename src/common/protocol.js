export const MSG = Object.freeze({
  REGISTER: 'register',
  STATE_UPDATE: 'state-update',
  REPORT_RESULT: 'report-result',
  SESSIONS_RESULT: 'sessions-result', // workhorse → controller: its adoptable sessions
  EVENT: 'event',
  COMMAND: 'command',
  SETTINGS_PUSH: 'settings-push',
  SYNC: 'sync',                 // controller → workhorse: authoritative record roster
  SYNC_REQUEST: 'sync-request', // workhorse → controller: send me my roster (on (re)connect)
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
  LIST_SESSIONS: 'list-sessions', // enumerate the workhorse's adoptable Claude sessions
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

// desiredState only advances toward a terminal state (never resurrect a
// closed/failed instance). Used by both the controller merge and the workhorse
// sync-apply so the two sides can't disagree on the rule.
const _DRANK = { alive: 0, closing: 1, closed: 2, failed: 2 };
export function maxDesiredState(a, b) {
  if (!b) return a;
  if (!a) return b;
  return (_DRANK[b] ?? 0) > (_DRANK[a] ?? 0) ? b : a;
}

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
