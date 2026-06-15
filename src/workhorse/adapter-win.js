import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../common/config.js';

const EXECKEE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_PATH = join(EXECKEE_ROOT, 'src', 'instance-hook.js');
const INSTANCE_SETTINGS_FILE = join(config.DATA_DIR, 'instance-settings.json');

// Session-scoped settings injected at launch via `claude --settings <file>`.
// Carries the UserPromptSubmit hook that handles in-instance `hide`/`close`.
// The user's global ~/.claude is never modified.
let settingsWritten = false;
function ensureInstanceSettings() {
  if (settingsWritten) return INSTANCE_SETTINGS_FILE;
  const settings = {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: `node "${HOOK_PATH}"` }] },
      ],
    },
  };
  writeFileSync(INSTANCE_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  settingsWritten = true;
  return INSTANCE_SETTINGS_FILE;
}

// Native Windows adapter.
//
// Design (machine-verified 2026-06-14):
//   - Launch claude.exe DIRECTLY via Start-Process -PassThru. The returned PID is
//     the durable, window-owning process (claude.exe does NOT trampoline for an
//     interactive launch; conhost is its child).
//   - claude.exe owns a real top-level window. Its MainWindowHandle is non-zero
//     ONLY while the window is visible — once hidden it reads 0. Therefore the
//     handle MUST be cached at launch and reused for hide/show; never re-derived.
//   - Liveness is a single signal: is the launched PID alive? (When claude exits,
//     its window closes — no zombie window, unlike a cmd /k wrapper.)
//   - alive/kill operate by PID; hide/show operate by the cached window handle.
//
// Fallback (not used in the normal path): if a cached handle is ever lost, the
// console window can be recovered via FreeConsole/AttachConsole(pid)/GetConsoleWindow.

const PS_HELPER = join(config.DATA_DIR, '_win32-helper.ps1');

const PS_HELPER_CONTENT = `
param(
    [string]$Action,
    [int]$ProcId = 0,
    [string]$Handle = "0",
    [string]$Cwd = ".",
    [string]$ArgString = "",
    [string]$InstanceId = "",
    [string]$DataDir = ""
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ExeckeeWin32 {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetSystemMenu(IntPtr hWnd, bool bRevert);
    [DllImport("user32.dll")] public static extern bool DeleteMenu(IntPtr hMenu, uint uPosition, uint uFlags);
    public const int SW_HIDE = 0;
    public const int SW_RESTORE = 9;
    public const uint SC_CLOSE = 0xF060;
    public const uint MF_BYCOMMAND = 0x0;
}
"@

switch ($Action) {
    "launch" {
        if ($InstanceId -and $InstanceId.Length -gt 0) {
            # Inherited by claude and by its hook child processes (§ in-instance control).
            $env:EXECKEE_INSTANCE_ID = $InstanceId
        }
        if ($DataDir -and $DataDir.Length -gt 0) {
            # So the in-instance hook resolves the workhorse's OWN local mirror.
            $env:EXECKEE_DATA_DIR = $DataDir
        }
        $sp = @{ FilePath = 'claude'; PassThru = $true; WorkingDirectory = $Cwd }
        if ($ArgString -and $ArgString.Trim().Length -gt 0) {
            $sp['ArgumentList'] = $ArgString.Split(' ')
        }
        $p = Start-Process @sp
        $procId = $p.Id
        $h = 0
        # MainWindowHandle lags the launch; poll up to ~12s for it to appear.
        for ($i = 0; $i -lt 48; $i++) {
            Start-Sleep -Milliseconds 250
            $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
            if (-not $proc) { break }   # launched process died
            $proc.Refresh()
            if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
                $h = [int64]$proc.MainWindowHandle
                break
            }
        }
        if ($h -ne 0) {
            # X button must never kill the instance (§4.1, §4.6a permanence): remove
            # the close item from the window's system menu so the X cannot terminate
            # it. Backgrounding is done via typed 'hide' or the primary.
            $hwnd = [IntPtr]$h
            $menu = [ExeckeeWin32]::GetSystemMenu($hwnd, $false)
            if ($menu -ne [IntPtr]::Zero) {
                [ExeckeeWin32]::DeleteMenu($menu, [ExeckeeWin32]::SC_CLOSE, [ExeckeeWin32]::MF_BYCOMMAND) | Out-Null
            }
        }
        Write-Output "$procId $h"
    }
    "alive" {
        $proc = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
        if ($proc) { Write-Output "true" } else { Write-Output "false" }
    }
    "hide" {
        $hwnd = [IntPtr][int64]$Handle
        if ([ExeckeeWin32]::IsWindow($hwnd)) {
            [ExeckeeWin32]::ShowWindow($hwnd, [ExeckeeWin32]::SW_HIDE) | Out-Null
            Write-Output "ok"
        } else {
            Write-Output "no-window"
        }
    }
    "show" {
        $hwnd = [IntPtr][int64]$Handle
        if ([ExeckeeWin32]::IsWindow($hwnd)) {
            [ExeckeeWin32]::ShowWindow($hwnd, [ExeckeeWin32]::SW_RESTORE) | Out-Null
            [ExeckeeWin32]::SetForegroundWindow($hwnd) | Out-Null
            Write-Output "ok"
        } else {
            Write-Output "no-window"
        }
    }
    "visible" {
        $hwnd = [IntPtr][int64]$Handle
        if ([ExeckeeWin32]::IsWindow($hwnd)) {
            Write-Output ([ExeckeeWin32]::IsWindowVisible($hwnd))
        } else {
            Write-Output "False"
        }
    }
    "kill" {
        & taskkill.exe /PID $ProcId /T /F 2>$null | Out-Null
        Write-Output "ok"
    }
}
`;

let helperWritten = false;

function ensureHelper() {
  if (!helperWritten) {
    writeFileSync(PS_HELPER, PS_HELPER_CONTENT, 'utf-8');
    helperWritten = true;
  }
}

function runHelper(params) {
  ensureHelper();
  const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_HELPER];
  for (const [k, v] of Object.entries(params)) {
    argv.push(`-${k}`, `${v}`);
  }
  try {
    // execFileSync runs powershell.exe directly (no cmd.exe shell) with the
    // window hidden, so these calls never flash a console.
    return execFileSync('powershell', argv, {
      encoding: 'utf-8',
      timeout: 30_000,
      windowsHide: true,
    }).trim();
  } catch (err) {
    console.error(`[adapter-win] Helper error (${params.Action}):`, err.message);
    return '';
  }
}

function doLaunch(instanceId, claudeArgs, projectPath) {
  const cwd = projectPath || process.cwd();
  const settings = ensureInstanceSettings();
  const argString = [...claudeArgs, '--settings', settings].join(' ');
  const out = runHelper({ Action: 'launch', Cwd: cwd, ArgString: argString, InstanceId: instanceId, DataDir: config.DATA_DIR });
  const [pidStr, handleStr] = out.split(/\s+/);
  const pid = parseInt(pidStr, 10) || null;
  const windowHandle = handleStr && handleStr !== '0' ? handleStr : null;
  return { pid, windowHandle };
}

export function launchInstance(instanceId, sessionId, projectPath) {
  const result = doLaunch(instanceId, ['--resume', sessionId], projectPath);
  console.log(`[adapter-win] Launched ${instanceId}: pid=${result.pid} hwnd=${result.windowHandle}`);
  return result;
}

export function createNewInstance(instanceId, projectPath) {
  const result = doLaunch(instanceId, [], projectPath);
  console.log(`[adapter-win] Created ${instanceId}: pid=${result.pid} hwnd=${result.windowHandle}`);
  return result;
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  // Native, window-less liveness check — runs every cycle, so it must not
  // spawn a PowerShell/console each time (that was the flashing-windows bug).
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function hideWindow(windowHandle) {
  if (!windowHandle) return false;
  return runHelper({ Action: 'hide', Handle: windowHandle }) === 'ok';
}

export function showWindow(windowHandle) {
  if (!windowHandle) return false;
  return runHelper({ Action: 'show', Handle: windowHandle }) === 'ok';
}

export function isWindowVisible(windowHandle) {
  if (!windowHandle) return false;
  return runHelper({ Action: 'visible', Handle: windowHandle }).toLowerCase() === 'true';
}

export function killInstance(pid) {
  if (!pid) return false;
  return runHelper({ Action: 'kill', ProcId: pid }) === 'ok';
}
