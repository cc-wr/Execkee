import { existsSync, readFileSync, unlinkSync } from 'fs';
import config from './config.js';
import { atomicWriteJson } from './safe-fs.js';

// The controller's primary window is the operator's own console. It is NOT a managed
// instance, and nothing in instance management may adopt it, probe it, or hide it.
//
// This exists because the two sides are different processes. The supervisor knows what
// the primary is; the workhorse does the adopting and hiding. Without a published
// record the workhorse cannot tell the primary from any other `claude.exe`, and the
// `findsession` helper — which matches on a session id ANYWHERE in a command line —
// matched the primary's own `--resume <id>`. The instance then took the primary's pid
// and window handle and applied its default hidden visibility, so the controller's
// window vanished while its process kept running. (Seen 2026-11-13: instance
// inst-mvy0lppg held session a5444313, the primary's.)
//
// A missing or stale file means "no primary here" and every guard below no-ops, which
// is the right answer for a workhorse on another machine: the primary's window only
// exists where the controller runs.

// `hwnd` is captured a few seconds after launch, so earlier writes carry none. Keep any
// handle already on file rather than erasing it: without it the hideWindow guard — the
// one that directly prevents the controller's window being hidden — cannot fire.
export function writePrimaryInfo({ pid, sessionId, cwd, hwnd }) {
  try {
    const prev = readPrimaryInfo() || {};
    const samePid = prev.pid && Number(prev.pid) === Number(pid);
    atomicWriteJson(config.PRIMARY_FILE, {
      pid: pid || null,
      sessionId: sessionId || prev.sessionId || null,
      cwd: cwd || prev.cwd || null,
      hwnd: hwnd || (samePid ? prev.hwnd : null) || null,
      updatedAt: new Date().toISOString(),
    });
  } catch { /* advisory only — never fail a launch over it */ }
}

export function clearPrimaryInfo() {
  try { if (existsSync(config.PRIMARY_FILE)) unlinkSync(config.PRIMARY_FILE); } catch {}
}

export function readPrimaryInfo() {
  try {
    if (!existsSync(config.PRIMARY_FILE)) return null;
    const o = JSON.parse(readFileSync(config.PRIMARY_FILE, 'utf-8'));
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}

// Is this pid the live primary? The pid is only trusted while the record is the
// current one — a stale pid could have been recycled onto an unrelated process, and
// refusing to manage an innocent instance is worse than the guard not firing.
export function isPrimaryPid(pid) {
  if (!pid) return false;
  const p = readPrimaryInfo();
  return !!p && Number(p.pid) === Number(pid);
}

export function isPrimarySession(sessionId) {
  if (!sessionId) return false;
  const p = readPrimaryInfo();
  return !!p && !!p.sessionId && String(p.sessionId) === String(sessionId);
}

// The ~/.claude/projects directory name Claude Code derives from the primary's cwd:
// every character outside [A-Za-z0-9] becomes '-'. Verified against the real slug for
// C:\Users\ccooley\.execkee\life-tasks => C--Users-ccooley--execkee-life-tasks.
// Returns null when there is no primary, so callers must treat null as "no exclusion".
export function primarySlug() {
  const p = readPrimaryInfo();
  if (!p || !p.cwd) return null;
  return String(p.cwd).replace(/[^A-Za-z0-9]/g, '-');
}
