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
    const result = await api('/api/resolve', 'POST', { issueId, message });
    console.log(result.success ? 'Resolved.' : `Failed: ${result.error}`);
    break;
  }

  case 'manage': {
    const [sessionId, ...nameParts] = args;
    const name = nameParts.join(' ') || 'Managed Session';
    if (!sessionId) {
      console.error('Usage: manage <session-id> [name]');
      process.exit(1);
    }
    const state = await api('/api/state');
    const wh = state.workhorses?.[0];
    if (!wh) {
      console.error('No workhorse connected. Start the subcontroller first.');
      process.exit(1);
    }
    const instanceId = `inst-${Date.now().toString(36)}`;
    const result = await api('/api/dispatch', 'POST', {
      workhorseId: wh.id,
      command: 'manage',
      instanceId,
      id: instanceId,
      name,
      sessionId,
    });
    console.log(result.success !== false ? `Managed as ${instanceId}` : `Failed: ${result.error}`);
    break;
  }

  case 'create': {
    const [name, projectPath] = args;
    if (!name) {
      console.error('Usage: create <name> [project-path]');
      process.exit(1);
    }
    const state = await api('/api/state');
    const wh = state.workhorses?.[0];
    if (!wh) {
      console.error('No workhorse connected. Start the subcontroller first.');
      process.exit(1);
    }
    const instanceId = `inst-${Date.now().toString(36)}`;
    const result = await api('/api/dispatch', 'POST', {
      workhorseId: wh.id,
      command: 'create',
      instanceId,
      id: instanceId,
      name,
      projectPath: projectPath || null,
    });
    console.log(result.success !== false ? `Created ${instanceId}` : `Failed: ${result.error}`);
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

  case 'dashboard': {
    const data = await api('/api/dashboard-data');
    console.log(JSON.stringify(data, null, 2));
    break;
  }

  case 'sessions': {
    const projectsDir = join(homedir(), '.claude', 'projects');
    if (!existsSync(projectsDir)) {
      console.log('No Claude projects directory found.');
      break;
    }
    for (const slug of readdirSync(projectsDir)) {
      const slugDir = join(projectsDir, slug);
      if (!statSync(slugDir).isDirectory()) continue;
      const jsonls = readdirSync(slugDir).filter(f => f.endsWith('.jsonl'));
      if (jsonls.length === 0) continue;
      console.log(`${slug}/`);
      for (const f of jsonls) {
        const sessionId = f.replace('.jsonl', '');
        const stat = statSync(join(slugDir, f));
        const size = (stat.size / 1024).toFixed(1);
        const mod = stat.mtime.toISOString().split('T')[0];
        console.log(`  ${sessionId}  (${size}KB, ${mod})`);
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
    console.log('  manage <session-id> <name> Adopt an existing Claude session');
    console.log('  create <name> [path]       Create a new managed instance');
    console.log('  foreground <instance-id>   Bring an instance to front');
    console.log('  hide <instance-id>         Hide an instance');
    console.log('  close <instance-id>        Close an instance');
    console.log('  dashboard                  Show raw dashboard data');
    console.log('  sessions                   List available Claude sessions');
    break;
}
