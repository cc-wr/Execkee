import { createHash } from 'crypto';
import { existsSync, statSync, readFileSync, writeFileSync, copyFileSync, renameSync, watchFile, unwatchFile } from 'fs';
import { join } from 'path';
import config from './config.js';

// Bidirectional sync of Claude Code USER settings across the controller and every
// workhorse, over the existing WS hub (controller = canonical store + rebroadcaster).
//
// SAFETY (the whole reason this is an explicit allowlist, not a directory sync):
//   - Only the basenames in SYNCED_FILES, directly under ~/.claude, are ever read,
//     transmitted, or written. No globbing, no recursion, no directories. So
//     credential/state files (.credentials.json, .claude.json, sessions/, projects/,
//     history.jsonl, cache/, todos/, statsig/) CANNOT be synced by construction.
//   - JSON files are JSON-validated before being written (a malformed settings.json
//     would break Claude Code); non-JSON files (CLAUDE.md) skip that check. The prior
//     file is backed up to <name>.execkee-bak. Writes are atomic (temp + rename).
//   - Every operation is wrapped so a failure logs and is swallowed — settings sync
//     must never crash the supervisor or workhorse. Disable entirely with
//     EXECKEE_SETTINGS_SYNC=0.
//
// Synced: the Claude Code user settings (settings.json) and the user's GLOBAL
// instructions (CLAUDE.md) — the latter is the user's own authored file, propagated
// verbatim across their machines, never modified in transit.
// To extend coverage later (e.g. commands/, skills/), this needs a recursive variant
// with the same allowlist discipline — do NOT just add a directory name here.
export const SYNCED_FILES = ['settings.json', 'CLAUDE.md'];

// Last hash we know each local file to hold. Set both when we APPLY an incoming
// change and when the watcher observes a local edit, so an apply we just performed
// is not mistaken for a user edit and re-broadcast (the loop guard).
const _known = Object.create(null);

function claudePath(name) {
  return join(config.CLAUDE_DIR, name);
}

export function hashOf(content) {
  return createHash('sha1').update(content == null ? '' : String(content)).digest('hex');
}

function isAllowed(name) {
  // Defense in depth: reject anything not an exact allowlisted basename (no path
  // separators, no traversal) before it can reach the filesystem.
  return SYNCED_FILES.includes(name) && !name.includes('/') && !name.includes('\\') && !name.includes('..');
}

// Read one allowlisted file's current state, or null if it doesn't exist / errors.
export function readSynced(name) {
  if (!isAllowed(name)) return null;
  const p = claudePath(name);
  try {
    if (!existsSync(p)) return null;
    const content = readFileSync(p, 'utf-8');
    const mtime = statSync(p).mtimeMs;
    return { name, content, mtime, hash: hashOf(content) };
  } catch (err) {
    console.error(`[settings-sync] read ${name} failed: ${err.message}`);
    return null;
  }
}

// Snapshot every allowlisted file that exists on this machine.
export function snapshotLocal() {
  const out = [];
  for (const name of SYNCED_FILES) {
    const f = readSynced(name);
    if (f) out.push(f);
  }
  return out;
}

// Apply an incoming (validated) settings file to this machine's ~/.claude. Records
// the applied hash in _known so the ensuing watcher fire is recognized as our own
// write and not re-broadcast. Returns { applied, reason }.
export function applyIncoming({ name, content }) {
  if (!isAllowed(name)) return { applied: false, reason: 'not allowlisted' };
  if (typeof content !== 'string') return { applied: false, reason: 'no content' };
  // A .json file must parse — never write garbage that would break Claude Code.
  // Non-JSON files (CLAUDE.md) accept any text.
  if (name.endsWith('.json')) {
    try { JSON.parse(content); } catch { return { applied: false, reason: 'invalid JSON' }; }
  }

  const incomingHash = hashOf(content);
  // Already identical on disk — nothing to do (and keep _known in step).
  const cur = readSynced(name);
  if (cur && cur.hash === incomingHash) { _known[name] = incomingHash; return { applied: false, reason: 'identical' }; }

  const target = claudePath(name);
  const tmp = `${target}.execkee-tmp`;
  try {
    writeFileSync(tmp, content, 'utf-8');
    if (existsSync(target)) {
      try { copyFileSync(target, `${target}.execkee-bak`); } catch {}
    }
    renameSync(tmp, target); // libuv rename overwrites on Windows (MOVEFILE_REPLACE_EXISTING)
    _known[name] = incomingHash;
    console.log(`[settings-sync] applied ${name} (${content.length} bytes)`);
    return { applied: true };
  } catch (err) {
    console.error(`[settings-sync] apply ${name} failed: ${err.message}`);
    try { if (existsSync(tmp)) renameSync(tmp, `${tmp}.failed`); } catch {}
    return { applied: false, reason: err.message };
  }
}

// Watch the allowlisted files for genuine local edits. onLocalChange is called only
// when a file's content hash differs from what we last applied/observed (so our own
// applyIncoming writes don't echo). Returns a stop() function.
export function startWatch(onLocalChange, pollMs = config.SETTINGS_SYNC_POLL_MS) {
  // Seed _known from the current on-disk content so the first edit (not the current
  // state) is what triggers a report.
  for (const name of SYNCED_FILES) {
    const f = readSynced(name);
    if (f) _known[name] = f.hash;
  }
  const watchers = [];
  for (const name of SYNCED_FILES) {
    const p = claudePath(name);
    const listener = () => {
      try {
        const f = readSynced(name);
        if (!f) return;                       // deleted/unreadable — ignore (never propagate a delete)
        if (f.hash === _known[name]) return;  // our own apply, or no real change
        _known[name] = f.hash;
        onLocalChange(f);
      } catch (err) {
        console.error(`[settings-sync] watch ${name} error: ${err.message}`);
      }
    };
    // watchFile polls (interval ms) — robust on Windows and across editors that
    // replace-on-save (which fs.watch can miss).
    watchFile(p, { interval: pollMs }, listener);
    watchers.push(p);
  }
  console.log(`[settings-sync] watching ${watchers.length} file(s) every ${pollMs}ms`);
  return () => { for (const p of watchers) { try { unwatchFile(p); } catch {} } };
}
