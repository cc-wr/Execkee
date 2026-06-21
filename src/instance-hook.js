#!/usr/bin/env node

// Hook injected into managed instances via `--settings` (session-scoped — the user's
// global ~/.claude is never touched). Wired for BOTH UserPromptSubmit and SessionStart:
// on every prompt AND on session launch/resume/compact it captures the live `session_id`
// (KI-6) so the instance's stored session never drifts from the running one. The
// hide/close control words only apply to UserPromptSubmit (SessionStart has no prompt).
//
// It realizes the spec's in-instance control pathways:
//   - typed `hide`  → background this instance locally (§4.1 pathway 2)
//   - typed `close` → mark desiredState=closing locally, before the process
//                     exits, so the death is recognized as intentional, not a
//                     crash (§4.6a invariant); the subcontroller finalizes it.
// Both block the prompt from reaching the model. Anything else passes through.
// No-op when EXECKEE_INSTANCE_ID is unset (i.e. an unmanaged session).

import { readTracking, updateInstance, mutateTracking } from './common/tracking.js';
import { DESIRED_STATE, VISIBILITY } from './common/protocol.js';
import * as adapter from './workhorse/adapter.js';

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', d => (data += d));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

const raw = await readStdin();
let payload = {};
// Strip a leading BOM defensively before parsing (some shells prepend U+FEFF).
const clean = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
try { payload = JSON.parse(clean); } catch {}

const prompt = String(payload.prompt || '').trim().toLowerCase();
const instanceId = process.env.EXECKEE_INSTANCE_ID;

// KI-6: keep the instance's stored sessionId pointing at the LIVE session. The hook
// runs INSIDE the instance and Claude Code passes the current session_id on stdin,
// so this is exact and survives any branch/rewind/new-session. Update only on a real
// change, and never let a tracking hiccup block the user's prompt (always fall
// through to the control-word handling / pass-through below).
const liveSessionId = String(payload.session_id || '').trim();
const transcriptPath = String(payload.transcript_path || '').trim();
if (instanceId && liveSessionId) {
  try {
    // Serialized (mutateTracking) — the hook runs in its OWN process, concurrent with
    // the workhorse, both writing the same tracking.json; without the lock a stale
    // read + late write here could drop a concurrently-added instance.
    mutateTracking(t => {
      const inst = t.instances[instanceId];
      if (!inst) return false;
      const idChanged = inst.sessionId !== liveSessionId;
      const pathChanged = transcriptPath && inst.transcriptPath !== transcriptPath;
      if (!(idChanged || pathChanged)) return false;
      // Record the EXACT live transcript the instance is writing (transcript_path) so
      // the cycle's report reads it directly — no id/slug guessing, survives a
      // continued/forked id or a different cwd, and needs no re-adopt. Reset the
      // watermark on an id change so the new session is reported in full.
      const patch = { sessionId: liveSessionId };
      if (transcriptPath) patch.transcriptPath = transcriptPath;
      if (idChanged) patch.watermark = null;
      updateInstance(t, instanceId, patch);
    });
  } catch {}
}

// Pass through to the model for anything that isn't an in-instance control word.
if (!instanceId || (prompt !== 'hide' && prompt !== 'close')) {
  process.exit(0);
}

const inst = readTracking().instances[instanceId];
if (!inst) process.exit(0);

if (prompt === 'hide') {
  adapter.hideWindow(inst.windowHandle); // adapter call outside the lock
  mutateTracking(t => { if (!t.instances[instanceId]) return false; updateInstance(t, instanceId, { visibility: VISIBILITY.HIDDEN }); });
  process.stderr.write('[execkee] Instance hidden — pull it up from the primary when you need it.\n');
  process.exit(2); // block the prompt
}

if (prompt === 'close') {
  mutateTracking(t => { if (!t.instances[instanceId]) return false; updateInstance(t, instanceId, { desiredState: DESIRED_STATE.CLOSING }); });
  process.stderr.write('[execkee] Closing this instance.\n');
  process.exit(2); // block the prompt; subcontroller monitor kills + finalizes
}
