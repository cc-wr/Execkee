import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readDashboardData } from '../common/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML_PATH = join(__dirname, '..', '..', 'dashboard', 'index.html');

export class DashboardServer {
  constructor({ port, hub }) {
    this.port = port;
    this.hub = hub;
    this.server = null;
    this.sseClients = new Set();
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

    if (url.pathname === '/api/resolve' && req.method === 'POST') {
      return this._handleApiResolve(req, res);
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

  async _handleApiDispatch(req, res) {
    const body = await this._readBody(req);
    try {
      const { workhorseId, command, instanceId, ...params } = JSON.parse(body);
      const result = await this.hub.sendCommand(workhorseId, command, { instanceId, ...params });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
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
      const { issueId, message } = JSON.parse(body);
      const { logResolution } = await import('../common/store.js');
      logResolution(issueId, message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
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
