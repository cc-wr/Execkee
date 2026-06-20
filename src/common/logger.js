import { appendFileSync, existsSync, mkdirSync, statSync, renameSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import config from './config.js';

// Robust, persistent process logging. Each long-lived process (server/controller,
// workhorse, supervisor) tees its full stdout+stderr to a rotating file under
// ~/.execkee/logs/, and the primary's conversation is tailed into a readable
// primary-chat.log — so when a bug is raised the logs are at a fixed, known path.
//
// Design notes:
//   - initProcessLog() monkey-patches process.stdout/stderr.write to ALSO append
//     to the file; the original write still goes to the terminal, so behavior is
//     unchanged. Everything already logged via console.* is captured, no call-site
//     changes needed.
//   - Everything is wrapped in try/catch and gated by EXECKEE_LOG=off, so logging
//     can never break the process it instruments.
//   - Size-based rotation keeps one previous file (<name>.1.log).

export const LOG_DIR = join(config.DATA_DIR, 'logs');
const MAX_BYTES = Number(process.env.EXECKEE_LOG_MAX_BYTES) || 5 * 1024 * 1024;

function ensureDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

class RotatingLog {
  constructor(name) {
    this.file = join(LOG_DIR, `${name}.log`);
    ensureDir();
    this.bytes = existsSync(this.file) ? statSync(this.file).size : 0;
  }
  // appendFileSync (not a write stream) so no file handle is held open: Windows
  // refuses to rename an open file, which silently broke stream-based rotation.
  // Volume here is modest (process logs), so the sync append cost is negligible.
  write(text) {
    try {
      appendFileSync(this.file, text);
      this.bytes += Buffer.byteLength(text);
      if (this.bytes > MAX_BYTES) {
        try { renameSync(this.file, this.file.replace(/\.log$/, '.1.log')); } catch {} // overwrites prior .1.log
        this.bytes = 0; // next append recreates <name>.log
      }
    } catch {}
  }
}

// Prefix each non-empty line with an ISO timestamp. console.* writes one line per
// call, so this yields per-line timestamps in the common case.
function stamp(chunk) {
  const s = typeof chunk === 'string' ? chunk : (chunk && chunk.toString ? chunk.toString('utf8') : String(chunk));
  return s.replace(/^(?!$)/gm, `[${new Date().toISOString()}] `);
}

let installed = false;
export function initProcessLog(name) {
  if (installed || process.env.EXECKEE_LOG === 'off') return;
  installed = true;
  try {
    const log = new RotatingLog(name);
    for (const key of ['stdout', 'stderr']) {
      const s = process[key];
      const orig = s.write.bind(s);
      s.write = (...args) => {
        try { log.write(stamp(args[0])); } catch {}
        return orig(...args);
      };
    }
    log.write(`\n==== ${name} started ${new Date().toISOString()} pid=${process.pid} ====\n`);
  } catch {}
}

// --- Primary-surface chat log -------------------------------------------------

function extractText(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => {
      if (typeof p === 'string') return p;
      if (!p || typeof p !== 'object') return '';
      if (p.type === 'text' || p.text) return p.text || '';
      if (p.type === 'tool_use') return `[tool:${p.name || '?'}]`;
      if (p.type === 'tool_result') return '[tool_result]';
      return '';
    }).filter(Boolean).join(' ');
  }
  return '';
}

function readableTurn(line) {
  if (!line.trim()) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (o.type !== 'user' && o.type !== 'assistant') return null;
  const text = extractText(o.message);
  if (!text || !text.trim()) return null;
  return `[${o.timestamp || ''}] ${o.type === 'user' ? 'USER' : 'ASSISTANT'}: ${text.replace(/\s+/g, ' ').trim().slice(0, 2000)}`;
}

let chatLog = null;

// Append any NEW user/assistant turns from the primary's transcript to
// primary-chat.log. `state` = { id, pos } is mutated in place across calls. On the
// first sight of a session id it attaches at the current end (does not dump the
// backlog), then logs turns going forward. Caveat: if the primary is driven via
// Remote Control its transcript freezes (see KI-9) and this stops updating.
export function tailPrimaryChat(sessionId, transcriptPath, state) {
  try {
    if (!sessionId || !transcriptPath || !existsSync(transcriptPath)) return;
    const size = statSync(transcriptPath).size;
    if (state.id !== sessionId) { state.id = sessionId; state.pos = size; return; }
    if (size <= state.pos) return;
    const fd = openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(size - state.pos);
    readSync(fd, buf, 0, buf.length, state.pos);
    closeSync(fd);
    state.pos = size;
    if (!chatLog) chatLog = new RotatingLog('primary-chat');
    for (const line of buf.toString('utf8').split('\n')) {
      const turn = readableTurn(line);
      if (turn) chatLog.write(turn + '\n');
    }
  } catch {}
}
