// Platform dispatcher for the workhorse window/process adapter.
//
// Managing each Claude Code instance as a real OS window it can launch, hide,
// show, and kill is the ONLY platform-specific surface of a workhorse; the rest
// (sockets, tracking, reports, settings sync) is OS-agnostic. This module picks
// the concrete adapter at load time from process.platform and re-exports its API
// unchanged, so instances.js / instance-hook.js are written once against one
// interface and gain a new OS by adding a branch here — nothing else changes.
//
//   win32  -> adapter-win.js  (PowerShell + Win32 console-window control)
//   darwin -> adapter-mac.js  (Terminal.app via AppleScript / osascript)
//
// The wrong-platform module is never even imported (the ternary short-circuits),
// so e.g. adapter-mac.js's macOS-only assumptions never load on Windows.

import process from 'node:process';

const impl =
  process.platform === 'darwin' ? await import('./adapter-mac.js') :
  process.platform === 'win32' ? await import('./adapter-win.js') :
  null;

if (!impl) {
  throw new Error(
    `[adapter] Unsupported platform '${process.platform}' — the Execkee workhorse supports win32 and darwin.`
  );
}

export const launchInstance = impl.launchInstance;
export const createNewInstance = impl.createNewInstance;
export const isProcessAlive = impl.isProcessAlive;
export const hideWindow = impl.hideWindow;
export const showWindow = impl.showWindow;
export const isWindowVisible = impl.isWindowVisible;
export const killInstance = impl.killInstance;
