import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  readDashboardData, writeDashboardData,
  readSentenceQueue, writeSentenceQueue,
  logResolution,
} from '../common/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML_PATH = join(__dirname, '..', '..', 'dashboard', 'index.html');

export class DashboardServer {
  constructor({ port, hub }) {
    this.port = port;
    this.hub = hub;
    this.server = null;
    this.sseClients = new Set();
    this.onRunCycle = null; // set by index.js; runs a cycle on demand
    this.onRefreshTasks = null; // set by index.js; cheap dashboard task refresh
    this.onApproveTask = null; // set by index.js; approve a tentative guess (or all)
    this.onRejectTask = null; // set by index.js; drop a tentative guess
    this.onRegenerateGuesses = null; // set by index.js; force a fresh tracked-file guess
    this.onDefer = null; // set by index.js; add a structured deferral
    this.onUndefer = null; // set by index.js; remove a deferral
    this.onListDeferrals = null; // set by index.js; list active deferrals
    this.onScheduleGuess = null; // set by index.js; schedule a future guessed task
    this.onUnscheduleGuess = null; // set by index.js; remove a scheduled guess
    this.onListScheduledGuesses = null; // set by index.js; list scheduled guesses
  }

  start() {
    this.server = createServer((req, res) => {
      this._handleRequest(req, res);
    });

    this.server.listen(this.port, () => {
      console.log(`[dashboard] HTTP server listening on port ${this.port}`);
      console.log(`[dashboard] Open http://localhost:${this.port} in your browser`);
    });
  }

  pushUpdate() {
    const data = readDashboardData();
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  _handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);

    if (url.pathname === '/api/events') {
      return this._handleSSE(req, res);
    }

    if (url.pathname === '/api/state') {
      return this._handleApiState(req, res);
    }

    if (url.pathname === '/api/dispatch' && req.method === 'POST') {
      return this._handleApiDispatch(req, res);
    }

    if (url.pathname === '/api/dashboard-data') {
      return this._handleApiDashboardData(req, res);
    }

    if (url.pathname === '/api/sessions') {
      return this._handleApiSessions(req, res);
    }

    if (url.pathname === '/api/resolve' && req.method === 'POST') {
      return this._handleApiResolve(req, res);
    }

    if (url.pathname === '/api/run-cycle' && req.method === 'POST') {
      return this._handleApiRunCycle(req, res);
    }

    if (url.pathname === '/api/refresh-tasks' && req.method === 'POST') {
      return this._handleApiRefreshTasks(req, res);
    }

    if (url.pathname === '/api/approve-task' && req.method === 'POST') {
      return this._handleApiApproveTask(req, res);
    }

    if (url.pathname === '/api/reject-task' && req.method === 'POST') {
      return this._handleApiRejectTask(req, res);
    }

    if (url.pathname === '/api/regenerate-guesses' && req.method === 'POST') {
      return this._handleApiRegenerateGuesses(req, res);
    }

    if (url.pathname === '/api/defer' && req.method === 'POST') {
      return this._handleApiDefer(req, res);
    }

    if (url.pathname === '/api/undefer' && req.method === 'POST') {
      return this._handleApiUndefer(req, res);
    }

    if (url.pathname === '/api/deferrals') {
      return this._handleApiDeferrals(req, res);
    }

    if (url.pathname === '/api/schedule-guess' && req.method === 'POST') {
      return this._handleApiScheduleGuess(req, res);
    }

    if (url.pathname === '/api/unschedule-guess' && req.method === 'POST') {
      return this._handleApiUnscheduleGuess(req, res);
    }

    if (url.pathname === '/api/scheduled-guesses') {
      return this._handleApiScheduledGuesses(req, res);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return this._serveDashboard(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  _handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const data = readDashboardData();
    res.write(`data: ${JSON.stringify(data)}\n\n`);

    this.sseClients.add(res);
    req.on('close', () => this.sseClients.delete(res));
  }

  _handleApiState(req, res) {
    const state = this.hub.queryState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
  }

  async _handleApiSessions(req, res) {
    try {
      const workhorses = await this.hub.listSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ workhorses }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ workhorses: [], error: err.message }));
    }
  }

  async _handleApiDispatch(req, res) {
    const body = await this._readBody(req);
    try {
      const { workhorseId, command, instanceId, ...params } = JSON.parse(body);
      const result = await this.hub.sendCommand(workhorseId, command, { instanceId, ...params });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      // §A.11: adopting a session auto-runs a cycle so its baseline report is
      // produced immediately — no manual "force a cycle" step. Fire-and-forget;
      // the report only runs if the instance is hidden (visibility = lock).
      if (command === 'manage' && result && result.success !== false && this.onRunCycle) {
        Promise.resolve(this.onRunCycle()).then(() => this.pushUpdate()).catch(() => {});
      }
      // Un-adopt: the workhorse has dropped+stopped the instance; also remove it
      // from master tracking so it disappears from status/dashboard.
      if (command === 'unmanage' && result && result.success !== false) {
        this.hub.forgetInstance(instanceId);
        this.pushUpdate();
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  _handleApiDashboardData(req, res) {
    const data = readDashboardData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  async _handleApiResolve(req, res) {
    const body = await this._readBody(req);
    try {
      const { issueId, message, resolved } = JSON.parse(body);

      // Resolution-only rule (§4.10): the primary owns the resolved-vs-discussion
      // judgment. Mutate the dashboard ONLY when it asserts resolved === true.
      // Anything else (discussion, "unsure") leaves the sentence untouched.
      if (resolved !== true) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, resolved: false }));
        return;
      }

      logResolution(issueId, message);

      // Promote the next pre-staged secondary sentence, or fall to "Stand by."
      const queue = readSentenceQueue();
      const data = readDashboardData();
      if (data.sentence && data.sentence.id === issueId) {
        const next = (queue.secondaries || []).shift() || null;
        writeSentenceQueue({ major: next, secondaries: queue.secondaries || [] });
        if (next) {
          data.sentence = { id: next.id, text: next.text, priority: 1 };
          data.standby = false;
        } else {
          data.sentence = null;
          data.standby = true;
        }
        data.updatedBy = 'primary';
        writeDashboardData(data);
        this.pushUpdate();
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, resolved: true, promoted: data.sentence }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  async _handleApiRunCycle(req, res) {
    if (!this.onRunCycle) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'No cycle runner wired' }));
      return;
    }
    try {
      await this.onRunCycle();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  async _handleApiRefreshTasks(req, res) {
    if (!this.onRefreshTasks) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'No task-refresh wired' }));
      return;
    }
    try {
      await this.onRefreshTasks();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  async _handleApiApproveTask(req, res) {
    const body = await this._readBody(req);
    if (!this.onApproveTask) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'No approve-task wired' }));
      return;
    }
    try {
      const { id, all } = JSON.parse(body || '{}');
      const result = await this.onApproveTask({ id, all: !!all });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  async _handleApiRejectTask(req, res) {
    const body = await this._readBody(req);
    if (!this.onRejectTask) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'No reject-task wired' }));
      return;
    }
    try {
      const { id } = JSON.parse(body || '{}');
      const result = await this.onRejectTask(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  async _handleApiRegenerateGuesses(req, res) {
    if (!this.onRegenerateGuesses) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'No regenerate-guesses wired' }));
      return;
    }
    try {
      const result = await this.onRegenerateGuesses();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  async _handleApiDefer(req, res) {
    const body = await this._readBody(req);
    if (!this.onDefer) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'No defer wired' }));
      return;
    }
    try {
      const { topic, until } = JSON.parse(body || '{}');
      const result = await this.onDefer({ topic, until: until || null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  async _handleApiUndefer(req, res) {
    const body = await this._readBody(req);
    if (!this.onUndefer) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'No undefer wired' }));
      return;
    }
    try {
      const { id } = JSON.parse(body || '{}');
      const result = await this.onUndefer(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  async _handleApiDeferrals(req, res) {
    try {
      const deferrals = this.onListDeferrals ? await this.onListDeferrals() : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deferrals }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deferrals: [], error: err.message }));
    }
  }

  async _handleApiScheduleGuess(req, res) {
    const body = await this._readBody(req);
    if (!this.onScheduleGuess) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'No schedule-guess wired' }));
      return;
    }
    try {
      const { text, on, until, horizon } = JSON.parse(body || '{}');
      const result = await this.onScheduleGuess({ text, on: on || null, until: until || null, horizon: !!horizon });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  async _handleApiUnscheduleGuess(req, res) {
    const body = await this._readBody(req);
    if (!this.onUnscheduleGuess) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'No unschedule-guess wired' }));
      return;
    }
    try {
      const { id } = JSON.parse(body || '{}');
      const result = await this.onUnscheduleGuess(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  async _handleApiScheduledGuesses(req, res) {
    try {
      const items = this.onListScheduledGuesses ? await this.onListScheduledGuesses() : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [], error: err.message }));
    }
  }

  _serveDashboard(req, res) {
    try {
      const html = readFileSync(DASHBOARD_HTML_PATH, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Dashboard template not found: ' + err.message);
    }
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  stop() {
    for (const client of this.sseClients) {
      try { client.end(); } catch {}
    }
    this.sseClients.clear();
    if (this.server) this.server.close();
  }
}
