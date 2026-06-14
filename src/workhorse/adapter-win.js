import { execSync, spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import config from '../common/config.js';

const PS_HELPER = join(config.DATA_DIR, '_win32-helper.ps1');

const PS_HELPER_CONTENT = `
param(
    [string]$Action,
    [string]$Title,
    [string]$Cmd
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;

public class ExeckeeWin32 {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    public const int SW_HIDE = 0;
    public const int SW_SHOW = 5;
    public const int SW_MINIMIZE = 6;
    public const int SW_RESTORE = 9;
}
"@

switch ($Action) {
    "find" {
        $hwnd = [ExeckeeWin32]::FindWindow([NullString]::Value, $Title)
        Write-Output $hwnd.ToInt64()
    }
    "visible" {
        $hwnd = [ExeckeeWin32]::FindWindow([NullString]::Value, $Title)
        if ($hwnd -ne [IntPtr]::Zero) {
            Write-Output ([ExeckeeWin32]::IsWindowVisible($hwnd))
        } else {
            Write-Output "False"
        }
    }
    "hide" {
        $hwnd = [ExeckeeWin32]::FindWindow([NullString]::Value, $Title)
        if ($hwnd -ne [IntPtr]::Zero) {
            [ExeckeeWin32]::ShowWindow($hwnd, [ExeckeeWin32]::SW_HIDE) | Out-Null
            Write-Output "ok"
        } else {
            Write-Output "notfound"
        }
    }
    "show" {
        $hwnd = [ExeckeeWin32]::FindWindow([NullString]::Value, $Title)
        if ($hwnd -ne [IntPtr]::Zero) {
            [ExeckeeWin32]::ShowWindow($hwnd, [ExeckeeWin32]::SW_RESTORE) | Out-Null
            [ExeckeeWin32]::SetForegroundWindow($hwnd) | Out-Null
            Write-Output "ok"
        } else {
            Write-Output "notfound"
        }
    }
    "alive" {
        $procs = Get-Process | Where-Object { $_.MainWindowTitle -eq $Title }
        if ($procs) { Write-Output "true" } else { Write-Output "false" }
    }
    "kill" {
        $procs = Get-Process | Where-Object { $_.MainWindowTitle -eq $Title }
        if ($procs) {
            $procs | Stop-Process -Force
            Write-Output "ok"
        } else {
            Write-Output "notfound"
        }
    }
}
`;

function ensureHelper() {
  writeFileSync(PS_HELPER, PS_HELPER_CONTENT, 'utf-8');
}

function runHelper(action, title, extra) {
  ensureHelper();
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', PS_HELPER,
    '-Action', action,
    '-Title', title,
  ];
  if (extra) {
    args.push('-Cmd', extra);
  }
  try {
    return execSync(`powershell ${args.map(a => `"${a}"`).join(' ')}`, {
      encoding: 'utf-8',
      timeout: 15_000,
      windowsHide: true,
    }).trim();
  } catch (err) {
    console.error(`[adapter-win] Helper error (${action}):`, err.message);
    return '';
  }
}

function windowTitle(instanceId) {
  return `${config.WINDOW_TITLE_PREFIX}-${instanceId}`;
}

export function launchInstance(instanceId, sessionId, projectPath) {
  const title = windowTitle(instanceId);
  const claudeCmd = `claude --resume ${sessionId}`;
  const cwd = projectPath || config.HOME;

  const child = spawn('cmd.exe', ['/c', 'start', `"${title}"`, 'cmd', '/k', claudeCmd], {
    stdio: 'ignore',
    windowsHide: true,
    cwd,
  });
  child.unref();

  return { title };
}

export function createNewInstance(instanceId, projectPath) {
  const title = windowTitle(instanceId);
  const cwd = projectPath || config.HOME;

  const child = spawn('cmd.exe', ['/c', 'start', `"${title}"`, 'cmd', '/k', 'claude'], {
    stdio: 'ignore',
    windowsHide: true,
    cwd,
  });
  child.unref();

  return { title };
}

export function hideWindow(instanceId) {
  return runHelper('hide', windowTitle(instanceId)) === 'ok';
}

export function showWindow(instanceId) {
  return runHelper('show', windowTitle(instanceId)) === 'ok';
}

export function isWindowVisible(instanceId) {
  return runHelper('visible', windowTitle(instanceId)).toLowerCase() === 'true';
}

export function isProcessAlive(instanceId) {
  return runHelper('alive', windowTitle(instanceId)) === 'true';
}

export function killInstance(instanceId) {
  return runHelper('kill', windowTitle(instanceId)) === 'ok';
}

export function findWindowHandle(instanceId) {
  const result = runHelper('find', windowTitle(instanceId));
  return result && result !== '0' ? result : null;
}
