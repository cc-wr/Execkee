import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import config from '../common/config.js';

// Windows console probe — the low-level half of the "probe report" mechanism
// (see probe.js). It lets the workhorse READ a managed instance's console
// screen buffer and INJECT keystrokes into it, by attaching to that process's
// console (AttachConsole) and using ReadConsoleOutputCharacter / WriteConsoleInput.
//
// Why this exists: when an instance is driven through Remote Control (or its
// transcript otherwise doesn't land on local disk), the fork-from-file report is
// stale. Reading the live console frame and asking the live model for a report
// sidesteps the file entirely. Validated 2026-06-20: inject reached a real
// claude TUI (it answered) and the frame read back correctly.
//
// The console juggling (FreeConsole/AttachConsole) happens in a SHORT-LIVED child
// powershell, never in the workhorse's own process, so it can't disturb us.

export const probeSupported = true;

const PROBE_HELPER = join(config.DATA_DIR, '_win32-probe.ps1');

// Single-quoted PS here-string for the C# so its `$` (CONOUT$/CONIN$) stay
// literal; no `${...}` or backticks appear, so this is safe inside a JS template.
const HELPER_CONTENT = `param([string]$Action, [int]$ProcId, [string]$B64Text = "")
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class ExeckeeProbe {
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr sec, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI i);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ReadConsoleOutputCharacterW(IntPtr h, StringBuilder b, uint len, COORD c, out uint read);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] r, uint len, out uint written);
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct CSBI { public COORD size; public COORD cur; public ushort attr; public SMALL_RECT win; public COORD max; }
  [StructLayout(LayoutKind.Sequential)] public struct KEY_EVENT_RECORD { public int down; public ushort rep; public ushort vk; public ushort scan; public ushort ch; public uint ctrl; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT_RECORD { [FieldOffset(0)] public ushort type; [FieldOffset(4)] public KEY_EVENT_RECORD key; }
  const uint GR=0x80000000, GW=0x40000000, SR=1, SW=2, OPENX=3;
  static IntPtr Conout(){ return CreateFileW("CONOUT$", GR|GW, SR|SW, IntPtr.Zero, OPENX, 0, IntPtr.Zero); }
  static IntPtr Conin(){ return CreateFileW("CONIN$", GR|GW, SR|SW, IntPtr.Zero, OPENX, 0, IntPtr.Zero); }
  public static string ReadFrame(uint pid){
    FreeConsole(); if(!AttachConsole(pid)) return "ATTACH_FAIL:"+Marshal.GetLastWin32Error();
    IntPtr h=Conout(); CSBI i; GetConsoleScreenBufferInfo(h, out i); var sb=new StringBuilder();
    for(short y=i.win.T; y<=i.win.B; y++){ var line=new StringBuilder(i.size.X+1); uint read; COORD c; c.X=0; c.Y=y; ReadConsoleOutputCharacterW(h, line, (uint)i.size.X, c, out read); sb.Append(line.ToString().TrimEnd()); sb.Append((char)10); }
    CloseHandle(h); FreeConsole(); return "OK:"+Convert.ToBase64String(Encoding.UTF8.GetBytes(sb.ToString()));
  }
  static INPUT_RECORD K(ushort vk, char ch, bool down){ var r=new INPUT_RECORD(); r.type=1; r.key=new KEY_EVENT_RECORD(); r.key.down=down?1:0; r.key.rep=1; r.key.vk=vk; r.key.scan=0; r.key.ch=(ushort)ch; r.key.ctrl=0; return r; }
  public static string Inject(uint pid, string text){
    FreeConsole(); if(!AttachConsole(pid)) return "ATTACH_FAIL:"+Marshal.GetLastWin32Error();
    IntPtr h=Conin();
    if(h==IntPtr.Zero || h==new IntPtr(-1)){ FreeConsole(); return "INJECT_FAIL:conin:"+Marshal.GetLastWin32Error(); }
    var recs=new List<INPUT_RECORD>();
    foreach(char ch in text){ recs.Add(K(0,ch,true)); recs.Add(K(0,ch,false)); }
    var arr=recs.ToArray(); uint w; bool ok1=WriteConsoleInputW(h, arr, (uint)arr.Length, out w);
    // Submit on a SEPARATE event after a pause: if Enter rides in the same batch
    // as the text, the TUI's submit handler fires before the typed text commits to
    // its input state, leaving the prompt sitting unsent in the box.
    System.Threading.Thread.Sleep(600);
    var ent=new INPUT_RECORD[]{ K(0x0D,(char)13,true), K(0x0D,(char)13,false) };
    uint w2; bool ok2=WriteConsoleInputW(h, ent, (uint)ent.Length, out w2);
    CloseHandle(h); FreeConsole();
    if(!ok1 || !ok2 || (w+w2)==0) return "INJECT_FAIL:write:"+Marshal.GetLastWin32Error();
    return "wrote:"+(w+w2);
  }
}
'@
switch ($Action) {
  "readframe" { [ExeckeeProbe]::ReadFrame([uint32]$ProcId) }
  "inject" {
    $txt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($B64Text))
    [ExeckeeProbe]::Inject([uint32]$ProcId, $txt)
  }
}
`;

let helperWritten = false;
function ensureHelper() {
  if (helperWritten) return;
  writeFileSync(PROBE_HELPER, HELPER_CONTENT, 'utf-8');
  helperWritten = true;
}

function run(args, timeout = 20_000) {
  ensureHelper();
  try {
    return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PROBE_HELPER, ...args], {
      encoding: 'utf-8',
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`[probe-win] helper error (${args[0]}):`, err.message);
    return '';
  }
}

// Read the visible console screen buffer of `pid` as plain text (one line per row).
// The helper returns "OK:<base64-utf8>" so box-drawing/Unicode survive any console
// codepage; "ATTACH_FAIL:<n>" if the process has no attachable console.
export function readFrame(pid) {
  if (!pid) return '';
  const out = run(['readframe', String(pid)]).trim();
  if (out.startsWith('ATTACH_FAIL')) return out;
  if (out.startsWith('OK:')) {
    try { return Buffer.from(out.slice(3), 'base64').toString('utf-8'); } catch { return ''; }
  }
  return out;
}

// Type `text` followed by Enter into `pid`'s console input buffer. Text is passed
// base64 so prompt punctuation/newlines never break the command line.
export function injectText(pid, text) {
  if (!pid) return false;
  const b64 = Buffer.from(String(text), 'utf-8').toString('base64');
  const out = run(['inject', String(pid), b64]);
  return /^wrote:[1-9]\d*/.test(out.trim()); // positive count only; rejects wrote:0 / INJECT_FAIL
}
