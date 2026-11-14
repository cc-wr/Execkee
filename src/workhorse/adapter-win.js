import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../common/config.js';
import { readPrimaryInfo } from '../common/primary.js';

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
      // SessionStart fires on launch/resume/clear/compact with the live session_id, so
      // the instance's own id is captured IMMEDIATELY (not just on the next prompt) —
      // keeps inst.sessionId exact for reports/resume. Same hook script as below.
      SessionStart: [
        { hooks: [{ type: 'command', command: `node "${HOOK_PATH}"` }] },
      ],
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
    [string]$DataDir = "",
    [string]$SessionId = "",
    [string]$GatewayUrl = "",
    [string]$CustomModel = "",
    [string]$CustomModelName = ""
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
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
    public struct RECT { public int Left, Top, Right, Bottom; }
    public const int SW_HIDE = 0;
    public const int SW_SHOW = 5;
    public const int SW_RESTORE = 9;
    public const int SM_CXSCREEN = 0;
    public const int SM_CYSCREEN = 1;
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
        if ($GatewayUrl -and $GatewayUrl.Length -gt 0) {
            # Gateway-routed instance: claude sends its API traffic (with its own
            # OAuth credentials) to the local agentgateway instead of api.anthropic.com.
            $env:ANTHROPIC_BASE_URL = $GatewayUrl
            if ($CustomModel -and $CustomModel.Length -gt 0) {
                # Adds the gateway's non-Anthropic model as a /model picker row. This
                # ADDS an entry; built-in aliases (opus/haiku/fable) are untouched.
                $env:ANTHROPIC_CUSTOM_MODEL_OPTION = $CustomModel
                $env:ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = $CustomModelName
                $env:ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = 'Served by the local Execkee gateway'
            }
        }
        $sp = @{ FilePath = 'claude'; PassThru = $true; WorkingDirectory = $Cwd }
        $argList = @()
        if ($ArgString -and $ArgString.Trim().Length -gt 0) {
            # Drop empty tokens (e.g. from a missing value) so Start-Process never
            # sees a null/empty element in ArgumentList.
            $argList = @($ArgString.Split(' ') | Where-Object { $_ -and $_.Length -gt 0 })
        }
        if ($argList.Count -gt 0) {
            $sp['ArgumentList'] = $argList
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
            # SW_RESTORE is correct ONLY for a minimized window. On anything else it
            # un-maximizes: a hidden-while-maximized window came back at its smaller
            # restore rect (measured 1936x1056 -> 993x519), so every hide/show quietly
            # shrank the user's window. SW_SHOW redisplays at the current size instead.
            if ([ExeckeeWin32]::IsIconic($hwnd)) {
                [ExeckeeWin32]::ShowWindow($hwnd, [ExeckeeWin32]::SW_RESTORE) | Out-Null
            } else {
                [ExeckeeWin32]::ShowWindow($hwnd, [ExeckeeWin32]::SW_SHOW) | Out-Null
            }
            # Size floor. Managed windows have been found collapsed to 24x55 — border
            # and title bar only — with that size persisted in the restore rect, so
            # showing them returns a sliver. What writes that rect is NOT established
            # (Execkee calls no sizing API), so this is a guard, not a root-cause fix:
            # hand back a usable window rather than an unusable one.
            $rect = New-Object ExeckeeWin32+RECT
            if ([ExeckeeWin32]::GetWindowRect($hwnd, [ref]$rect)) {
                $curW = $rect.Right - $rect.Left
                $curH = $rect.Bottom - $rect.Top
                if ($curW -lt 500 -or $curH -lt 400) {
                    $scrW = [ExeckeeWin32]::GetSystemMetrics([ExeckeeWin32]::SM_CXSCREEN)
                    $scrH = [ExeckeeWin32]::GetSystemMetrics([ExeckeeWin32]::SM_CYSCREEN)
                    $newW = [Math]::Min(1200, $scrW)
                    $newH = [Math]::Min(800, $scrH)
                    $newX = [int](($scrW - $newW) / 2)
                    $newY = [int](($scrH - $newH) / 2)
                    [ExeckeeWin32]::MoveWindow($hwnd, $newX, $newY, $newW, $newH, $true) | Out-Null
                }
            }
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
    "findsession" {
        # Find a running claude.exe whose command line resumes this session id (an
        # orphan from a prior run we lost track of). Returns "<pid> <handle>" of the
        # first match (handle 0 if the window is hidden), or "0 0" if none.
        $procId = 0; $h = 0
        if ($SessionId -and $SessionId.Length -gt 0) {
            $esc = [regex]::Escape($SessionId)
            $match = Get-CimInstance Win32_Process -Filter "Name='claude.exe'" -ErrorAction SilentlyContinue |
                     Where-Object { $_.CommandLine -and $_.CommandLine -match $esc } |
                     Select-Object -First 1
            if ($match) {
                $procId = $match.ProcessId
                $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
                if ($proc) { $proc.Refresh(); if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { $h = [int64]$proc.MainWindowHandle } }
            }
        }
        Write-Output "$procId $h"
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

function doLaunch(instanceId, claudeArgs, projectPath, gateway) {
  const cwd = projectPath || process.cwd();
  const settings = ensureInstanceSettings();
  // Optional native Remote Control (EXECKEE_REMOTE_CONTROL=1). Safe to add here:
  // instance launches carry no positional prompt, so `--remote-control` never
  // swallows one as a session name. Degrades gracefully if RC is ineligible.
  const rc = config.REMOTE_CONTROL_ENABLED ? ['--remote-control'] : [];
  const argString = [...claudeArgs, ...rc, '--settings', settings].join(' ');
  const params = { Action: 'launch', Cwd: cwd, ArgString: argString, InstanceId: instanceId, DataDir: config.DATA_DIR };
  if (gateway && config.GATEWAY_ENABLED) {
    params.GatewayUrl = config.GATEWAY_URL;
    if (config.GATEWAY_CUSTOM_MODEL) {
      params.CustomModel = config.GATEWAY_CUSTOM_MODEL;
      params.CustomModelName = config.GATEWAY_CUSTOM_MODEL_NAME;
    }
  }
  const out = runHelper(params);
  const [pidStr, handleStr] = out.split(/\s+/);
  const pid = parseInt(pidStr, 10) || null;
  const windowHandle = handleStr && handleStr !== '0' ? handleStr : null;
  return { pid, windowHandle };
}

export function launchInstance(instanceId, sessionId, projectPath, options = {}) {
  // A session-less instance (e.g. one created with no captured session) cannot be
  // --resume'd; launch it as a fresh window rather than passing '--resume undefined',
  // which builds a malformed ArgumentList and crash-loops (see KI-1).
  if (!sessionId) return createNewInstance(instanceId, projectPath, options);
  const claudeArgs = ['--resume', sessionId];
  // Adopt-with-full-permissions: run unattended, no approval prompts (silent on
  // Windows). Compatible with --resume — the primary launches the same way.
  if (options.skipPermissions) claudeArgs.push('--dangerously-skip-permissions');
  const result = doLaunch(instanceId, claudeArgs, projectPath, options.gateway);
  console.log(`[adapter-win] Launched ${instanceId}: pid=${result.pid} hwnd=${result.windowHandle}${options.skipPermissions ? ' [full permissions]' : ''}${options.gateway ? ' [gateway]' : ''}`);
  return result;
}

export function createNewInstance(instanceId, projectPath, options = {}) {
  const result = doLaunch(instanceId, [], projectPath, options.gateway);
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
  // Last line of defence. Whatever route gets here — adoption, crash recovery, an
  // explicit `hide` — the controller's own window is never a legitimate target. On
  // 2026-11-13 it was hidden while its process kept running, leaving no console to
  // operate the fleet from and nothing on screen to click.
  const primary = readPrimaryInfo();
  if (primary && primary.hwnd && String(primary.hwnd) === String(windowHandle)) {
    console.warn(`[adapter-win] refused to hide the controller's primary window (${windowHandle})`);
    return false;
  }
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

// Find an already-running claude window resuming `sessionId` (an orphan from a prior
// run we lost track of). Lets adoption REUSE it instead of launching a duplicate. The
// window handle is 0/null if the window is hidden (then it can't be hidden/shown until
// a relaunch, but its pid is still monitorable). Returns { pid, windowHandle } or null.
export function findSessionWindow(sessionId) {
  if (!sessionId) return null;
  const out = runHelper({ Action: 'findsession', SessionId: sessionId });
  const [pidStr, handleStr] = String(out).split(/\s+/);
  const pid = parseInt(pidStr, 10) || null;
  if (!pid) return null;
  return { pid, windowHandle: handleStr && handleStr !== '0' ? handleStr : null };
}
