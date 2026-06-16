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
      console.error('Usage: manage <session-id> [name] [--on <workhorse-id>] [--path <project-path>] [--from-now] [--open] [--full-permissions]');
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
    // Adopt with full permissions: launch the resumed instance with
    // --dangerously-skip-permissions so it runs unattended (no approval prompts).
    let skipPermissions = false;
    const fpIdx = rest.findIndex(a => a === '--full-permissions' || a === '--skip-permissions' || a === '--yolo');
    if (fpIdx >= 0) { skipPermissions = true; rest.splice(fpIdx, 1); }
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
      skipPermissions,
    });
    if (result.success === false) {
      console.log(`Failed: ${result.error}`);
    } else {
      console.log(`Managed as ${instanceId}${baseline ? '' : ' (from now)'}${alreadyOpen ? ' (adopted as foreground)' : ''}${skipPermissions ? ' [full permissions]' : ''}`);
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

  case 'refresh-tasks': {
    const result = await api('/api/refresh-tasks', 'POST', {});
    console.log(result.success !== false ? 'Dashboard task list refreshed.' : `Failed: ${result.error}`);
    break;
  }

  case 'plan': {
    // Today's plan: confirmed backlog items + tentative (LLM-guessed) tasks.
    const data = await api('/api/dashboard-data');
    const items = data.dailyTasks || [];
    if (!items.length) { console.log('(no plan items today)'); break; }
    for (const t of items) {
      const tag = t.tentative ? ' [TENTATIVE]' : '';
      const inst = t.instance ? ` · ${t.instance}` : ' · (no instance)';
      const st = t.complete ? 'done' : (t.status || 'pending');
      console.log(`  ${t.id}  ${t.text}  (${st}${inst})${tag}`);
    }
    const tentative = items.filter(t => t.tentative);
    if (tentative.length) console.log(`\n${tentative.length} tentative — approve-task <id> / approve-task --all / reject-task <id>`);
    break;
  }

  case 'approve-task': {
    const all = args.includes('--all');
    const id = args.find(a => !a.startsWith('--'));
    if (!all && !id) { console.log('Usage: approve-task <id> | approve-task --all'); break; }
    const result = await api('/api/approve-task', 'POST', all ? { all: true } : { id });
    if (result.success === false) console.log(`Failed: ${result.error}`);
    else if (all) console.log(`Approved ${result.approved} tentative task(s).`);
    else console.log(`Approved: ${result.promoted}`);
    break;
  }

  case 'reject-task': {
    const id = args.find(a => !a.startsWith('--'));
    if (!id) { console.log('Usage: reject-task <id>'); break; }
    const result = await api('/api/reject-task', 'POST', { id });
    console.log(result.success !== false ? 'Tentative task dropped.' : `Failed: ${result.error}`);
    break;
  }

  case 'regenerate-guesses': {
    // Forces a fresh tracked-file task guess now (LLM fork — takes a moment).
    const result = await api('/api/regenerate-guesses', 'POST', {});
    if (result.success === false) console.log(`Failed: ${result.error}`);
    else console.log(`Regenerated tentative guesses (${result.guesses} guessed task(s)).`);
    break;
  }

  case 'defer': {
    // defer <topic words...> [--until YYYY-MM-DD] — suppress related surfaced items.
    const ui = args.indexOf('--until');
    let until = null, topicArgs = args;
    if (ui >= 0) { until = args[ui + 1] || null; topicArgs = args.slice(0, ui).concat(args.slice(ui + 2)); }
    const topic = topicArgs.join(' ').trim();
    if (!topic) { console.log('Usage: defer "<topic>" [--until YYYY-MM-DD]'); break; }
    const result = await api('/api/defer', 'POST', { topic, until });
    console.log(result.success !== false ? `Deferred "${topic}"${until ? ` until ${until}` : ''}.` : `Failed: ${result.error}`);
    break;
  }

  case 'undefer': {
    const id = args.join(' ').trim();
    if (!id) { console.log('Usage: undefer <id|topic>'); break; }
    const result = await api('/api/undefer', 'POST', { id });
    console.log(result.success !== false ? 'Deferral removed (related items return next cycle).' : `Failed: ${result.error}`);
    break;
  }

  case 'deferrals': {
    const result = await api('/api/deferrals');
    const list = result.deferrals || [];
    if (!list.length) { console.log('(no deferrals)'); break; }
    for (const d of list) console.log(`  ${d.id}  ${d.topic}${d.until ? `  (until ${d.until})` : ''}`);
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
    console.log('  manage <session-id> [name] [--on <wh>] [--full-permissions]  Adopt a session (auto-routes to its workhorse)');
    console.log('  create <name> [path] [--on <wh>]        Create a new managed instance');
    console.log('  foreground <instance-id>   Bring an instance to front');
    console.log('  hide <instance-id>         Hide an instance');
    console.log('  close <instance-id>        Close an instance (shuts the window; session stays re-adoptable)');
    console.log('  unmanage <instance-id>     Release / un-adopt an instance (leaves its window running)');
    console.log('  dashboard                  Show raw dashboard data');
    console.log('  run-cycle                  Force a cycle now (regenerate the dashboard)');
    console.log('  refresh-tasks              Instantly refresh the dashboard task list from tasks.json (no cycle)');
    console.log("  plan                       Today's plan (confirmed + tentative guesses, with ids)");
    console.log('  approve-task <id> | --all  Approve a tentative guessed task (promotes it to the backlog)');
    console.log('  reject-task <id>           Drop a tentative guessed task');
    console.log('  regenerate-guesses         Force a fresh tracked-file task guess now (no wait for the daily rollover)');
    console.log('  defer "<topic>" [--until YYYY-MM-DD]  Put a topic on hold — its instance-surfaced tasks stop appearing');
    console.log('  undefer <id|topic>         Lift a deferral (items return next cycle)');
    console.log('  deferrals                  List active deferrals');
    console.log('  sessions [--all]           Adoptable sessions per workhorse (--all incl. managed)');
    console.log('  issue add <text>           Log an Execkee improvement/bug to the backlog');
    console.log('  issue [all]                List open (or all) backlog issues');
    console.log('  issue done <id>            Mark a backlog issue resolved');
    break;
}
