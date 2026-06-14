#!/usr/bin/env node

// Fork Spike Test (Build Order Step 0)
//
// Tests whether `claude -p --resume <id> --fork-session --no-session-persistence`
// produces a clean, complete report without disturbing the live session.
//
// Usage:
//   node src/spike.js <session-id>
//   node src/spike.js <session-id> --check-live
//     (also verifies the live session file is unmodified)

import { execSync } from 'child_process';
import { statSync, existsSync, readFileSync } from 'fs';
import { getSessionJsonlPath, getSessionPosition } from './workhorse/reporter.js';

const sessionId = process.argv[2];
const checkLive = process.argv.includes('--check-live');

if (!sessionId) {
  console.error('Usage: node src/spike.js <session-id> [--check-live]');
  console.error('');
  console.error('Provide a Claude Code session ID to test forking against.');
  console.error('Find session IDs in ~/.claude/projects/<project-slug>/');
  console.error('(The .jsonl filenames minus the extension are session IDs.)');
  process.exit(1);
}

console.log('=== Execkee Fork Spike Test ===');
console.log(`Session ID: ${sessionId}`);
console.log(`Check live session integrity: ${checkLive}`);
console.log('');

// Step 1: Find the session file
const sessionPath = getSessionJsonlPath(sessionId);
if (!sessionPath) {
  console.error('FAIL: Session file not found for ID:', sessionId);
  console.error('Searched in ~/.claude/projects/*/');
  process.exit(1);
}
console.log(`Session file: ${sessionPath}`);

// Step 2: Record pre-fork state
const preForkSize = statSync(sessionPath).size;
const preForkContent = checkLive ? readFileSync(sessionPath) : null;
console.log(`Pre-fork file size: ${preForkSize} bytes`);
console.log('');

// Step 3: Run the fork
console.log('Running fork...');
const prompt = 'Briefly describe what this conversation has been about in 2-3 sentences. Output only the description, nothing else.';
const cmd = `claude -p --resume ${sessionId} --fork-session --no-session-persistence --output-format json "${prompt.replace(/"/g, '\\"')}"`;

console.log(`Command: ${cmd}`);
console.log('');

let output;
const startTime = Date.now();
try {
  output = execSync(cmd, {
    encoding: 'utf-8',
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
} catch (err) {
  console.error('FAIL: Fork command failed');
  console.error('Exit code:', err.status);
  console.error('stderr:', err.stderr?.substring(0, 500));
  console.error('stdout:', err.stdout?.substring(0, 500));
  process.exit(1);
}

const elapsed = Date.now() - startTime;
console.log(`Fork completed in ${elapsed}ms`);
console.log('');

// Step 4: Parse output
let parsed;
let resultText = '';
try {
  parsed = JSON.parse(output);
  const events = Array.isArray(parsed) ? parsed : [parsed];
  const resultEvent = events.findLast(e => e.type === 'result');
  resultText = resultEvent?.result || '';
  const initEvent = events.find(e => e.type === 'system' && e.subtype === 'init');

  console.log('--- Fork Metadata ---');
  console.log(`Forked session ID: ${initEvent?.session_id || 'unknown'}`);
  console.log(`Model: ${initEvent?.model || 'unknown'}`);
  console.log(`Duration: ${resultEvent?.duration_ms || '?'}ms`);
  console.log(`Cost: $${resultEvent?.total_cost_usd?.toFixed(4) || '?'}`);
  console.log('');
  console.log('--- Fork Result ---');
  console.log(resultText.substring(0, 2000) || '(empty)');
  console.log('--- End ---');
} catch {
  console.log('--- Raw Output ---');
  console.log(output.substring(0, 2000));
  console.log('--- End ---');
  resultText = output;
}
console.log('');

// Step 5: Verify live session integrity
const postForkSize = statSync(sessionPath).size;
console.log(`Post-fork file size: ${postForkSize} bytes`);

if (postForkSize !== preForkSize) {
  console.warn(`WARNING: Session file size changed (${preForkSize} -> ${postForkSize})`);
  console.warn('The fork may have modified the live session!');
} else {
  console.log('OK: Session file size unchanged');
}

if (checkLive) {
  const postForkContent = readFileSync(sessionPath);
  if (Buffer.compare(preForkContent, postForkContent) === 0) {
    console.log('OK: Session file content byte-identical');
  } else {
    console.error('FAIL: Session file content changed after fork!');
    console.error('The fork modified the live session.');
    process.exit(1);
  }
}

console.log('');
console.log('=== Spike Results ===');
console.log(`Fork produced output: ${output.length > 0 ? 'YES' : 'NO'}`);
console.log(`Result text extracted: ${resultText.length > 0 ? 'YES' : 'NO'}`);
console.log(`Live session untouched: ${postForkSize === preForkSize ? 'YES' : 'MAYBE NOT'}`);
console.log(`Elapsed time: ${elapsed}ms`);
console.log('');

if (output.length > 0 && postForkSize === preForkSize) {
  console.log('PASS: Fork spike successful. Reporting can use pure fork path.');
} else if (output.length > 0) {
  console.log('PARTIAL: Fork produced output but may have modified the session.');
  console.log('Consider the close/resume fallback path.');
} else {
  console.log('FAIL: Fork produced no output.');
}
