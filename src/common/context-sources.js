// Extra context the 30-minute cycle synthesis should weigh, beyond tasks.json and
// the instance reports: the user's TRACKING.md (deferrals / decisions — binding) and
// any files listed in context-sources.json (e.g. a life-tasks .docx). Each source is
// read, converted to plain text, bounded, and returned as one labeled block.

import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { extname } from 'path';
import config from './config.js';

const PER_SOURCE_CHARS = 8000; // cap each source so one big file can't dominate
const TOTAL_CHARS = 24000;     // cap the whole context block fed into the prompt

function readTextFile(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return ''; }
}

// A .docx is an Open-XML zip; the body text is in word/document.xml. Extract it with
// .NET via PowerShell (Windows) so we need no extra npm dependency. Strip tags →
// text. Returns '' on any failure.
function extractDocx(path) {
  if (process.platform !== 'win32') return '[.docx extraction is Windows-only]';
  const ps = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[System.IO.Compression.ZipFile]::OpenRead($env:EXECKEE_SRC); try { $e=($zip.Entries | Where-Object { $_.FullName.Replace('\\','/') -eq 'word/document.xml' } | Select-Object -First 1); if($e){ $sr=New-Object System.IO.StreamReader($e.Open()); $x=$sr.ReadToEnd(); $sr.Dispose(); $t=$x -replace '</w:p>',\"\`n\" -replace '<[^>]+>',' '; ([System.Net.WebUtility]::HtmlDecode($t) -replace '[ \\t]+',' ').Trim() } } finally { $zip.Dispose() }`;
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf-8', timeout: 20000, windowsHide: true,
      env: { ...process.env, EXECKEE_SRC: path },
    }).trim();
  } catch {
    return '[.docx extraction failed]';
  }
}

function extractText(path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.docx') return extractDocx(path);
  if (['.md', '.txt', '.json', '.csv', '.log', '.text', '.markdown', ''].includes(ext)) return readTextFile(path);
  return `[unsupported file type: ${ext}]`;
}

// Returns a bounded, labeled context block (or '' if there's nothing).
export function readContextSources() {
  const parts = [];

  // 1. Tracking log — always included if present (deferrals/decisions are binding).
  if (existsSync(config.TRACKING_FILE)) {
    const t = readTextFile(config.TRACKING_FILE).trim();
    if (t) parts.push({ label: 'TRACKING LOG (user deferrals / decisions / new info — RESPECT THESE)', text: t });
  }

  // 2. User-configured sources (context-sources.json).
  if (existsSync(config.CONTEXT_SOURCES_FILE)) {
    let cfg = null;
    try { cfg = JSON.parse(readTextFile(config.CONTEXT_SOURCES_FILE)); } catch {}
    for (const s of (cfg && cfg.sources) || []) {
      const path = typeof s === 'string' ? s : (s && s.path);
      if (!path) continue;
      const label = (typeof s === 'object' && s && s.label) || path;
      if (!existsSync(path)) { parts.push({ label: `${label} [missing]`, text: '(file not found)' }); continue; }
      let text = extractText(path).trim();
      if (text.length > PER_SOURCE_CHARS) text = text.slice(0, PER_SOURCE_CHARS) + '\n…(truncated)';
      if (text) parts.push({ label, text });
    }
  }

  if (parts.length === 0) return '';
  let block = parts.map(p => `### ${p.label}\n${p.text}`).join('\n\n');
  if (block.length > TOTAL_CHARS) block = block.slice(0, TOTAL_CHARS) + '\n…(context truncated)';
  return block;
}
