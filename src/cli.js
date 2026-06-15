#!/usr/bin/env node

// Execkee CLI — interact with the controller from the command line
//
// Usage:
//   node src/cli.js status                     — show workhorses and instances
//   node src/cli.js instances                  — list all instances
//   node src/cli.js sentence                   — show current dashboard sentence
//   node src/cli.js resolve <issue-id> <msg>   — resolve a dashboard issue
//   node src/cli.js manage <session-id> <name> — adopt an existing session
//   node src/cli.js create <name> [path]       — create a new instance
//   node src/cli.js foreground <instance-id>   — bring instance to front
//   node src/cli.js hide <instance-id>         — hide instance
//   node src/cli.js close <instance-id>        — close instance
//   node src/cli.js dashboard                  — show dashboard data
//   node src/cli.js sessions                   — list available Claude sessions

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import config from './common/config.js';

const API_BASE = `http://localhost:${config.HTTP_PORT}`;

async function api(path, method = 'GET', body = null) {
  const options = { method };
  if (body) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const resp = await fetch(`${API_BASE}${path}`, options);
  return resp.json();
}

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'status': {
    const state = await api('/api/state');
    console.log('Workhorses:');
    if (state.workhorses?.length === 0) {
      console.log('  (none connected)');
    } else {
      for (const wh of state.workhorses || []) {
        const status = wh.connected ? 'online' : 'offline';
        console.log(`  ${wh.id} (${wh.name}) [${wh.os}] — ${status}`);
      }
    }
    console.log('');
    console.log('Instances:');
    if (state.instances?.length === 0) {
      console.log('  (none)');
    } else {
      for (const inst of state.instances || []) {
        const vis = inst.visibility === 'foreground' ? 'FG' : 'bg';
        console.log(`  ${inst.id} — ${inst.name} [${vis}] (${inst.desiredState}) on ${inst.workhorseId}`);
      }
    }
    break;
  }

  case 'instances': {
    const state = await api('/api/state');
    if (state.instances?.length === 0) {
      console.log('No managed instances.');
    } else {
      for (const inst of state.instances || []) {
        console.log(`${inst.id}`);
        console.log(`  Name:       ${inst.name}`);
        console.log(`  Session:    ${inst.sessionId}`);
        console.log(`  State:      ${inst.desiredState}`);
        console.log(`  Visibility: ${inst.visibility}`);
        console.log(`  Workhorse:  ${inst.workhorseId}`);
        console.log(`  Last:       ${inst.lastActivityTime || '—'}`);
        console.log('');
      }
    }
    break;
  }

  case 'sentence': {
    const data = await api('/api/dashboard-data');
    if (data.standby || !data.sentence) {
      console.log('Stand by.');
    } else {
      console.log(data.sentence.text);
      console.log(`  (id: ${data.sentence.id})`);
    }
    break;
  }

  case 'resolve': {
    const [issueId, ...rest] = args;
    const message = rest.join(' ');
    if (!issueId || !message) {
      console.error('Usage: resolve <issue-id> <message>');
      process.exit(1);
    }
    // Invoking resolve IS the primary's judgment that the issue is resolved
    // (§4.10). Mere discussion never calls this command.
    const result = await api('/api/resolve', 'POST', { issueId, message, resolved: true });
    if (result.success && result.resolved) {
      console.log(result.promoted ? `Resolved. Now showing: ${result.promoted.text}` : 'Resolved. Stand by.');
    } else {
      console.log(`Failed: ${result.error}`);
    }
    break;
  }

  case 'manage': {
    const [sessionId, ...rest] = args;
    if (!sessionId) {
      console.error('Usage: manage <session-id> [name] [--on <workhorse-id>] [--path <project-path>] [--from-now] [--open]');
      process.exit(1);
    }
    let name = 'Managed Session';
    let projectPath = process.cwd();
    const pathIdx = rest.indexOf('--path');
    if (pathIdx >= 0) {
      projectPath = rest[pathIdx + 1] || projectPath;
      rest.splice(pathIdx, 2);
    }
    // §A.11: adoption defaults to a full baseline report (the whole point of
    // adopting). --from-now opts out (watermark = current end, deltas only).
    let baseline = true;
    const fnIdx = rest.findIndex(a => a === '--from-now');
    if (fnIdx >= 0) { baseline = false; rest.splice(fnIdx, 1); }
    // accept --baseline / --from-start as explicit (already the default)
    const blIdx = rest.findIndex(a => a === '--baseline' || a === '--from-start');
    if (blIdx >= 0) { baseline = true; rest.splice(blIdx, 1); }
    // §4.6b secondary: session already open in a GUI the user holds.
    let alreadyOpen = false;
    const openIdx = rest.indexOf('--open');
    if (openIdx >= 0) { alreadyOpen = true; rest.splice(openIdx, 1); }
    // --on <workhorse-id>: force which workhorse adopts (else auto-route below).
    let onWorkhorse = null;
    const onIdx = rest.indexOf('--on');
    if (onIdx >= 0) { onWorkhorse = rest[onIdx + 1] || null; rest.splice(onIdx, 2); }
    if (rest.length > 0) name = rest.join(' ');
    // Route to the workhorse that actually owns this session: --on wins; else
    // find which host's session list contains it; else fall back to the first.
    let targetWorkhorse = onWorkhorse;
    if (!targetWorkhorse) {
      const sdata = await api('/api/sessions');
      for (const g of (sdata.workhorses || [])) {
        if ((g.sessions || []).some(s => s.sessionId === sessionId)) { targetWorkhorse = g.workhorseId; break; }
      }
    }
    if (!targetWorkhorse) {
      const state = await api('/api/state');
      targetWorkhorse = state.workhorses?.[0]?.id;
    }
    if (!targetWorkhorse) {
      console.error('No workhorse connected. Start a workhorse first.');
      process.exit(1);
    }
    const instanceId = `inst-${Date.now().toString(36)}`;
    const result = await api('/api/dispatch', 'POST', {
      workhorseId: targetWorkhorse,
      command: 'manage',
      instanceId,
      id: instanceId,
      name,
      sessionId,
      projectPath,
      baseline,
      alreadyOpen,
    });
    if (result.success === false) {
      console.log(`Failed: ${result.error}`);
    } else {
      console.log(`Managed as ${instanceId}${baseline ? '' : ' (from now)'}${alreadyOpen ? ' (adopted as foreground)' : ''}`);
    }
    break;
  }

  case 'issue': {
    const { readIssues, addIssue, writeIssues } = await import('./common/store.js');
    const sub = args[0];
    if (sub === 'add') {
      const text = args.slice(1).join(' ');
      if (!text) { console.error('Usage: issue add <text>'); process.exit(1); }
      const id = addIssue(text);
      console.log(`Logged ${id}`);
    } else if (sub === 'done' || sub === 'close') {
      const id = args[1];
      const data = readIssues();
      const iss = data.issues.find(i => i.id === id);
      if (iss) { iss.status = 'done'; iss.closedAt = new Date().toISOString(); writeIssues(data); console.log(`Closed ${id}`); }
      else { console.log(`Not found: ${id}`); }
    } else {
      // list (default) — open issues, or `issue all`
      const data = readIssues();
      const all = sub === 'all';
      const items = data.issues.filter(i => all || i.status === 'open');
      if (!items.length) { console.log(all ? 'No issues.' : 'No open issues.'); }
      else {
        for (const i of items) {
          console.log(`${i.status === 'open' ? '[ ]' : '[x]'} ${i.id}  ${i.text}`);
        }
      }
    }
    break;
  }

  case 'create': {
    const rest = [...args];
    // --on <workhorse-id>: which machine the new instance runs on (else first).
    let onWorkhorse = null;
    const onIdx = rest.indexOf('--on');
    if (onIdx >= 0) { onWorkhorse = rest[onIdx + 1] || null; rest.splice(onIdx, 2); }
    const [name, projectPath] = rest;
    if (!name) {
      console.error('Usage: create <name> [project-path] [--on <workhorse-id>]');
      process.exit(1);
    }
    const state = await api('/api/state');
    const targetWorkhorse = onWorkhorse || state.workhorses?.[0]?.id;
    if (!targetWorkhorse) {
      console.error('No workhorse connected. Start a workhorse first.');
      process.exit(1);
    }
    const instanceId = `inst-${Date.now().toString(36)}`;
    const result = await api('/api/dispatch', 'POST', {
      workhorseId: targetWorkhorse,
      command: 'create',
      instanceId,
      id: instanceId,
      name,
      projectPath: projectPath || null,
    });
    console.log(result.success !== false ? `Created ${instanceId} on ${targetWorkhorse}` : `Failed: ${result.error}`);
    break;
  }

  case 'foreground': {
    const [instanceId] = args;
    if (!instanceId) { console.error('Usage: foreground <instance-id>'); process.exit(1); }
    const state = await api('/api/state');
    const inst = state.instances?.find(i => i.id === instanceId);
    if (!inst) { console.error('Instance not found'); process.exit(1); }
    const result = await api('/api/dispatch', 'POST', {
      workhorseId: inst.workhorseId,
      command: 'foreground',
      instanceId,
    });
    console.log(result.success !== false ? 'Foregrounded.' : `Failed: ${result.error}`);
    break;
  }

  case 'hide': {
    const [instanceId] = args;
    if (!instanceId) { console.error('Usage: hide <instance-id>'); process.exit(1); }
    const state = await api('/api/state');
    const inst = state.instances?.find(i => i.id === instanceId);
    if (!inst) { console.error('Instance not found'); process.exit(1); }
    const result = await api('/api/dispatch', 'POST', {
      workhorseId: inst.workhorseId,
      command: 'hide',
      instanceId,
    });
    console.log(result.success !== false ? 'Hidden.' : `Failed: ${result.error}`);
    break;
  }

  case 'close': {
    const [instanceId] = args;
    if (!instanceId) { console.error('Usage: close <instance-id>'); process.exit(1); }
    const state = await api('/api/state');
    const inst = state.instances?.find(i => i.id === instanceId);
    if (!inst) { console.error('Instance not found'); process.exit(1); }
    const result = await api('/api/dispatch', 'POST', {
      workhorseId: inst.workhorseId,
      command: 'close',
      instanceId,
    });
    console.log(result.success !== false ? 'Closed.' : `Failed: ${result.error}`);
    break;
  }

  case 'unmanage': {
    const [instanceId] = args;
    if (!instanceId) { console.error('Usage: unmanage <instance-id>'); process.exit(1); }
    const state = await api('/api/state');
    const inst = state.instances?.find(i => i.id === instanceId);
    if (!inst) { console.error('Instance not found'); process.exit(1); }
    const result = await api('/api/dispatch', 'POST', { workhorseId: inst.workhorseId, command: 'unmanage', instanceId });
    console.log(result.success !== false ? 'Released (un-adopted; the Claude window is left running).' : `Failed: ${result.error}`);
    break;
  }

  case 'dashboard': {
    const data = await api('/api/dashboard-data');
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case 'run-cycle': {
    const result = await api('/api/run-cycle', 'POST', {});
    console.log(result.success !== false ? 'Cycle complete — dashboard regenerated.' : `Failed: ${result.error}`);
    break;
  }

  case 'sessions': {
    // Adoptable sessions live on EACH workhorse (its own ~/.claude/projects);
    // the controller aggregates them and tags which are already managed.
    const data = await api('/api/sessions');
    const groups = data.workhorses || [];
    if (groups.length === 0) { console.log('No workhorses connected.'); break; }
    const showAll = args.includes('--all');
    for (const g of groups) {
      console.log(`${g.workhorseName} (${g.workhorseId}):`);
      if (g.error) { console.log(`  (could not list: ${g.error})`); continue; }
      const list = showAll ? (g.sessions || []) : (g.sessions || []).filter(s => !s.managed);
      if (list.length === 0) { console.log(showAll ? '  (no sessions)' : '  (no unmanaged sessions)'); continue; }
      for (const s of list) {
        const size = (s.sizeBytes / 1024).toFixed(1);
        const mod = s.mtime ? s.mtime.split('T')[0] : '?';
        const tag = s.managed ? ' [managed]' : '';
        console.log(`  ${s.sessionId}  [${s.slug}]  (${size}KB, ${mod})${tag}`);
      }
    }
    break;
  }

  default:
    console.log('Execkee CLI');
    console.log('');
    console.log('Commands:');
    console.log('  status                     Show workhorses and instances');
    console.log('  instances                  Detailed instance list');
    console.log('  sentence                   Show current dashboard sentence');
    console.log('  resolve <id> <msg>         Resolve a dashboard issue');
    console.log('  manage <session-id> [name] [--on <wh>]  Adopt a session (auto-routes to its workhorse)');
    console.log('  create <name> [path] [--on <wh>]        Create a new managed instance');
    console.log('  foreground <instance-id>   Bring an instance to front');
    console.log('  hide <instance-id>         Hide an instance');
    console.log('  close <instance-id>        Close an instance (shuts the window; session stays re-adoptable)');
    console.log('  unmanage <instance-id>     Release / un-adopt an instance (leaves its window running)');
    console.log('  dashboard                  Show raw dashboard data');
    console.log('  run-cycle                  Force a cycle now (regenerate the dashboard)');
    console.log('  sessions [--all]           Adoptable sessions per workhorse (--all incl. managed)');
    console.log('  issue add <text>           Log an Execkee improvement/bug to the backlog');
    console.log('  issue [all]                List open (or all) backlog issues');
    console.log('  issue done <id>            Mark a backlog issue resolved');
    break;
}
