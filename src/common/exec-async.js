import { exec } from 'child_process';

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
