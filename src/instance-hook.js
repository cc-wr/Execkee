#!/usr/bin/env node

// UserPromptSubmit hook, injected into managed instances via `--settings`
// (session-scoped — the user's global ~/.claude is never touched).
//
// It realizes the spec's in-instance control pathways:
//   - typed `hide`  → background this instance locally (§4.1 pathway 2)
//   - typed `close` → mark desiredState=closing locally, before the process
//                     exits, so the death is recognized as intentional, not a
//                     crash (§4.6a invariant); the subcontroller finalizes it.
// Both block the prompt from reaching the model. Anything else passes through.
// No-op when EXECKEE_INSTANCE_ID is unset (i.e. an unmanaged session).

import { readTracking, writeTracking, updateInstance } from './common/tracking.js';
import { DESIRED_STATE, VISIBILITY } from './common/protocol.js';
import * as adapter from './workhorse/adapter-win.js';

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

// Pass through to the model for anything that isn't an in-instance control word.
if (!instanceId || (prompt !== 'hide' && prompt !== 'close')) {
  process.exit(0);
}

const tracking = readTracking();
const inst = tracking.instances[instanceId];
if (!inst) process.exit(0);

if (prompt === 'hide') {
  adapter.hideWindow(inst.windowHandle);
  updateInstance(tracking, instanceId, { visibility: VISIBILITY.HIDDEN });
  writeTracking(tracking);
  process.stderr.write('[execkee] Instance hidden — pull it up from the primary when you need it.\n');
  process.exit(2); // block the prompt
}

if (prompt === 'close') {
  updateInstance(tracking, instanceId, { desiredState: DESIRED_STATE.CLOSING });
  writeTracking(tracking);
  process.stderr.write('[execkee] Closing this instance.\n');
  process.exit(2); // block the prompt; subcontroller monitor kills + finalizes
}
