import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { dirname, basename, join } from 'path';

// Robust JSON persistence shared by the life-tasks store (store.js) and the instance
// tracking store (tracking.js). It exists because both files lost ALL data to the same
// failure class: a non-atomic / no-file-window write left a truncated-or-missing file,
// and a masking read turned that into the empty default, which the next write then
// persisted permanently. Each primitive below closes one step of that chain.

// Synchronous short sleep (no busy-spin) for the rename-retry loop.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

// Atomic write: write a temp file, then rename it over the target. renameSync maps to
// MoveFileEx(REPLACE_EXISTING) on Windows (atomic) but transiently fails with a sharing
// violation when another process/AV has the target open — so RETRY the rename briefly.
// We never unlink the target as a fallback: that opens a window with NO file, and a
// concurrent reader then sees "missing" and can persist an empty default over real data
// (the instance-tracking / tasks wipe). If the rename keeps failing we throw loudly
// rather than destroy or half-write the target.
export function atomicWriteJson(path, data) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  let lastErr;
  for (let i = 0; i < 12; i++) {
    try { renameSync(tmp, path); return; }
    catch (err) { lastErr = err; sleepSync(25); }
  }
  try { unlinkSync(tmp); } catch {}
  throw new Error(`atomicWriteJson: could not replace ${path} after retries (${lastErr && lastErr.message})`);
}

// Read JSON, distinguishing absent (legit -> fallback) from corrupt. On a parse/read
// error the file is PRESERVED (corrupt JSON is moved aside to <path>.corrupt-<ts>) so a
// later write cannot overwrite recoverable bytes with the empty fallback; it logs
// loudly and returns the fallback so the system keeps running. This is the fix for
// readJson / readTracking silently masking corruption as "empty".
export function readJsonSafe(path, fallback, label) {
  if (!existsSync(path)) return fallback;
  let raw;
  try { raw = readFileSync(path, 'utf-8'); }
  catch (err) {
    console.error(`[safe-fs] read failed for ${label || path}: ${err.message} — using fallback, file left intact`);
    return fallback;
  }
  try { return JSON.parse(raw); }
  catch (err) {
    const aside = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, aside);
      console.error(`[safe-fs] CORRUPT ${label || path}: ${err.message} — preserved as ${basename(aside)}; using fallback`);
    } catch (e2) {
      console.error(`[safe-fs] CORRUPT ${label || path}: ${err.message} — and could NOT preserve it (${e2.message}); using fallback`);
    }
    return fallback;
  }
}

// Cross-process advisory lock around a store's read-modify-write, so separate
// processes (e.g. the workhorse and each per-instance hook, all writing the same
// tracking.json) can't interleave their RMW and lose-update an instance. Held only
// around a SHORT synchronous read+modify+write — never across adapter calls or awaits.
// Degrades to "proceed unlocked" on timeout/error rather than ever deadlocking (the
// atomic write + guards still prevent the catastrophic case; only a rare lost-update
// can slip if the lock is contended for seconds, which shouldn't happen).
export function acquireLock(targetPath, { timeoutMs = 4000, staleMs = 15000 } = {}) {
  const lock = `${targetPath}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      writeFileSync(lock, `${process.pid} ${Date.now()}`, { flag: 'wx' });
      return lock;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        console.error(`[safe-fs] lock ${basename(lock)} error: ${err.message}; proceeding unlocked`);
        return null;
      }
      // Stale-holder reclaim: a lock older than staleMs means its holder probably died
      // mid-operation — steal it.
      try { if (Date.now() - statSync(lock).mtimeMs > staleMs) { unlinkSync(lock); continue; } } catch {}
      if (Date.now() - start > timeoutMs) {
        console.error(`[safe-fs] lock ${basename(lock)} busy >${timeoutMs}ms; proceeding unlocked`);
        return null;
      }
      sleepSync(15);
    }
  }
}

export function releaseLock(lock) {
  if (lock) { try { unlinkSync(lock); } catch {} }
}

// Keep a small rolling set of timestamped backups beside `path` (copy current -> .bak-<ts>,
// prune to the newest `keep`). Best-effort; never throws into the caller.
export function snapshotBackup(path, keep = 8) {
  try {
    if (!existsSync(path)) return;
    copyFileSync(path, `${path}.bak-${Date.now()}`);
    const dir = dirname(path), base = basename(path);
    const baks = readdirSync(dir).filter(f => f.startsWith(`${base}.bak-`)).sort();
    for (const f of baks.slice(0, Math.max(0, baks.length - keep))) {
      try { unlinkSync(join(dir, f)); } catch {}
    }
  } catch (err) {
    console.error(`[safe-fs] backup of ${path} failed: ${err.message}`);
  }
}
