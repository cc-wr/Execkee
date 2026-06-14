import { exec, spawn } from 'child_process';

export function execAsync(cmd, options = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, {
      encoding: 'utf-8',
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

// Active `claude` children, so a shutdown can kill any in-flight report fork
// instead of leaving it to its 120s timeout or OS orphan reaping.
const activeClaudeChildren = new Set();

export function killActiveClaudeRuns() {
  for (const child of activeClaudeChildren) {
    try { child.kill(); } catch {}
  }
  activeClaudeChildren.clear();
}

export function claudeRun(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    activeClaudeChildren.add(child);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude timed out after 120s'));
    }, options.timeout || 120_000);

    child.on('close', code => {
      clearTimeout(timer);
      activeClaudeChildren.delete(child);
      if (code === 0) {
        resolve(stdout);
      } else {
        const err = new Error(`claude exited with code ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });

    child.on('error', err => {
      clearTimeout(timer);
      activeClaudeChildren.delete(child);
      reject(err);
    });
  });
}
