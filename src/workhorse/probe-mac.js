import { execFileSync } from 'child_process';

// macOS console probe — the Darwin half of the "probe report" mechanism (probe.js).
// It reads a managed instance's Terminal.app frame and injects a prompt into it,
// using only AppleScript (the same Automation permission the mac adapter already
// requires — no extra Accessibility/keystroke grant, and no focus stealing):
//   - map the instance pid -> its controlling tty (`ps -o tty=`) -> the Terminal tab
//     whose `tty` matches (Terminal exposes `/dev/ttysNNN` per tab),
//   - read the frame with `get contents of <tab>`,
//   - inject with `do script "<text>" in <tab>`, which writes the text + Return to
//     the foreground process (claude) on that tab's tty — i.e. types into the TUI.
//
// NOTE (evidentiary gap): this is written from documented AppleScript/Terminal
// semantics but has NOT been exercised on Mac hardware (see STATUS.md KI-8). The
// `do script … in <tab>` submit behavior in particular should be verified live.

export const probeSupported = true;

function ttyOf(pid) {
  try {
    const raw = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf-8', timeout: 5000 }).trim();
    if (!raw || raw === '?' || raw === '??') return null;
    return raw.startsWith('/dev/') ? raw : `/dev/${raw}`;
  } catch {
    return null;
  }
}

function runOsa(script, timeout = 15000) {
  try {
    return execFileSync('osascript', ['-e', script], { encoding: 'utf-8', timeout, maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    console.error('[probe-mac] osascript error:', err.message);
    return '';
  }
}

// Read the Terminal tab bound to `pid`'s tty. Returns the visible contents (with
// macOS \r line breaks normalized to \n), or an ATTACH_FAIL marker so the caller
// degrades exactly like the Windows path.
export function readFrame(pid) {
  if (!pid) return '';
  const dev = ttyOf(pid);
  if (!dev) return 'ATTACH_FAIL:no-tty';
  const script = [
    'tell application "Terminal"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      try',
    `        if tty of t is "${dev}" then return contents of t`,
    '      end try',
    '    end repeat',
    '  end repeat',
    'end tell',
    'return "ATTACH_FAIL:no-tab"',
  ].join('\n');
  return runOsa(script).replace(/\r/g, '\n');
}

// Type `text` + Return into the claude TUI on `pid`'s tab. `do script … in <tab>`
// writes to the tab's foreground process (claude) rather than launching a new
// shell command, because the tab is already running claude.
export function injectText(pid, text) {
  if (!pid) return false;
  const dev = ttyOf(pid);
  if (!dev) return false;
  const esc = String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'tell application "Terminal"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      try',
    `        if tty of t is "${dev}" then`,
    `          do script "${esc}" in t`,
    '          return "ok"',
    '        end if',
    '      end try',
    '    end repeat',
    '  end repeat',
    'end tell',
    'return "no-tab"',
  ].join('\n');
  return runOsa(script).trim() === 'ok';
}
