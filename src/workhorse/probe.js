import process from 'node:process';
import config from '../common/config.js';

// "Probe report" — generate a status report by driving the LIVE instance instead
// of reading its on-disk transcript. The transcript is unreliable when a session
// is driven through Remote Control (it freezes locally); the live window always
// has the real conversation. So we read the instance's console frame, and — only
// if it is idle and its state has changed since last time — inject a short prompt
// asking the model to print a marker-delimited status report, then read that
// report back from the frame. The on-disk file is never consulted.
//
// This is OPT-IN (EXECKEE_PROBE_REPORTS=1). It is necessarily invasive: it appends
// a probe turn to the user's real conversation. The guards below exist to make it
// responsible: never inject mid-inference, never re-inject an unchanged session,
// and tell the model explicitly to change nothing.
//
// Platform: Windows is implemented + validated (probe-win.js). macOS reports
// unsupported (probe-mac.js) so the caller falls back to the fork report there.

const impl =
  process.platform === 'darwin' ? await import('./probe-mac.js') :
  process.platform === 'win32' ? await import('./probe-win.js') :
  null;

export const probeSupported = impl ? impl.probeSupported : false;
const readFrame = impl ? impl.readFrame : () => '';
const injectText = impl ? impl.injectText : () => false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Claude's TUI shows "esc to interrupt" (or similar) while the model is working.
function isBusy(frame) {
  return /esc to interrupt|to interrupt\)|\btool use\b.*running/i.test(frame);
}
// Heuristic that the input box / status bar is showing — i.e. it's awaiting input.
function looksReady(frame) {
  return /shift\+tab|bypass permissions|\btokens\b/i.test(frame) || /\n>\s/.test(frame);
}

// A modal/selection prompt (tool permission, trust-folder, onboarding, theme) is
// NOT generating and may still carry the footer chrome, so it can masquerade as
// "ready" — but injecting text + Enter would ANSWER the dialog (e.g. approve a
// tool call). Treat any such prompt as not-idle so the probe never injects into it.
function isInteractivePrompt(frame) {
  return /do you want to (proceed|allow|continue|trust)|do you trust the files|(^|\n)\s*[❯>]?\s*\d+\.\s+(yes|no|allow|deny|always|don'?t ask)|yes, and don'?t ask again|press\s+\d|esc to (cancel|reject|go back)/i.test(frame);
}

// Lines after the last marker that are real content (not the input box / status
// chrome). If none, the session hasn't advanced since that marker was printed.
function hasNewContentAfter(frame, marker) {
  if (!marker) return true;
  // Clean first: the TUI's input-box borders (╭─╮ │ ╰─╯) sit AFTER the marker on
  // an idle screen; uncleaned they read as "new content" and the unchanged-skip
  // never fires (re-probing the user's conversation every cycle). clean() maps
  // box-drawing to spaces so a border line collapses to '' / '>' and is skipped.
  const lines = frame.split('\n').map(clean);
  let idx = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(marker)) idx = i;
  if (idx < 0) return true; // marker scrolled off => conversation advanced
  for (const t of lines.slice(idx + 1)) {
    if (t.length <= 3) continue;            // blank / collapsed border / lone '>'
    if (t.startsWith('>')) continue;        // input prompt line
    if (/shift\+tab|bypass permissions|\btokens\b|for agents|auto-accept|to interrupt/i.test(t)) continue;
    return true; // a fresh turn after the marker
  }
  return false;
}

function buildPrompt(begin, end) {
  return [
    '[Execkee status probe] Do NOT edit, create, or delete any files and do NOT run any tools — reply in plain text only.',
    'Summarize THIS conversation for a status dashboard.',
    `First, a line containing only ${begin}.`,
    'Then a line: TOPIC: <a short title>.',
    'Then a line: STATUS: <2 to 4 sentences on what is done, what is in progress, what is blocked, and what needs attention>.',
    `Then a line containing only ${end} and stop. Do not write anything below that line.`,
  ].join(' ');
}

// Strip the TUI decoration the console buffer carries: box-drawing, block
// elements, and bullet glyphs that otherwise pepper the scraped text (borders
// show up at row edges and around the response panel).
function clean(s) {
  return s
    .replace(/[─-▟]/g, ' ') // box-drawing + block elements
    // Whitelist: keep ASCII printable + newline and common typography (hyphen/
    // en/em dash, curly quotes, ellipsis, arrow); drop everything else — the
    // console buffer's right-edge decoration glyphs are otherwise scraped into
    // the text. (Trade-off: rare non-Latin/accented chars are dropped from the
    // auto-summary; acceptable for a status sentence.)
    .replace(/[^\n\x20-\x7E‐-—‘-”…→]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Index of a STANDALONE marker line (the model prints the marker alone on a line),
// distinguished from the prompt echo where the marker sits inside a long sentence.
function markerLineIndex(cleanedLines, marker, before) {
  const limit = before == null ? cleanedLines.length : before;
  for (let i = limit - 1; i >= 0; i--) {
    const t = cleanedLines[i];
    if (t.includes(marker) && t.length <= marker.length + 3) return i;
  }
  return -1;
}

export function frameHasReport(frame, end) {
  return markerLineIndex(frame.split('\n').map(clean), end) >= 0;
}

function extractReport(frame, begin, end) {
  const lines = frame.split('\n').map(clean);
  const ei = markerLineIndex(lines, end);
  if (ei < 0) return null;
  const bi = markerLineIndex(lines, begin, ei);
  if (bi < 0) return null; // begin scrolled off the visible frame — refuse to parse
  // rather than scoop the wrapped prompt-echo into the summary; the poll loop will
  // retry, and on persistent miss the probe times out and falls back to the fork.
  const body = lines.slice(bi + 1, ei).filter(Boolean);
  let topic = '(probe)';
  const summaryParts = [];
  for (const l of body) {
    if (l.includes(begin) || l.includes(end)) continue;
    const mt = l.match(/TOPIC:\s*(.*)$/i);
    const ms = l.match(/STATUS:\s*(.*)$/i);
    if (mt) { topic = mt[1].trim() || topic; continue; }
    if (ms) { if (ms[1].trim()) summaryParts.push(ms[1].trim()); continue; }
    summaryParts.push(l); // continuation of a wrapped STATUS line
  }
  const summary = summaryParts.join(' ').replace(/\s+/g, ' ').trim();
  if (!summary) return null;
  return {
    topic,
    summary,
    recentWork: [],
    inProgress: [],
    blocked: [],
    completed: [],
    needsAttention: [],
    probe: true,
  };
}

// Drive `inst`'s live window to produce a report. Returns one of:
//   { success:true, report, marker }            — got a fresh report
//   { success:false, unchanged:true }            — idle + unchanged since lastMarker
//   { success:false, skipped:true, reason }      — busy / not-ready (try later)
//   { success:false, error }                     — failed (caller may fall back)
export async function probeReport(inst, { lastMarker } = {}) {
  const pid = inst && inst.pid;
  if (!probeSupported) return { success: false, error: 'probe not supported on this platform' };
  if (!pid) return { success: false, error: 'no pid' };

  const first = readFrame(pid);
  if (!first || first.startsWith('ATTACH_FAIL')) return { success: false, error: `cannot read console frame (${(first || '').trim() || 'empty'})` };

  // Wait until idle: the status bar is up (TUI ready) and it is NOT generating
  // (no "esc to interrupt") for two consecutive samples. Robust to a welcome
  // banner / rotating tip / cursor (which don't affect busy/ready), unlike exact
  // frame-equality. A still-loading or working window never builds the streak.
  let settled = null;
  let readyStreak = 0;
  for (let i = 0; i < config.PROBE_SETTLE_SAMPLES; i++) {
    await sleep(config.PROBE_IDLE_SETTLE_MS);
    const cur = readFrame(pid);
    if (cur.startsWith('ATTACH_FAIL')) return { success: false, error: 'console detached mid-probe' };
    if (isBusy(cur) || !looksReady(cur) || isInteractivePrompt(cur)) { readyStreak = 0; continue; }
    readyStreak++;
    settled = cur;
    if (readyStreak >= 2) break;
  }
  if (readyStreak < 2 || !settled) {
    const cur = readFrame(pid);
    const reason = isBusy(cur) ? 'instance is mid-inference'
      : isInteractivePrompt(cur) ? 'instance is at an interactive prompt (permission/trust)'
      : 'instance not idle/ready';
    return { success: false, skipped: true, reason };
  }
  if (lastMarker && !hasNewContentAfter(settled, lastMarker)) return { success: false, unchanged: true };

  const token = Math.random().toString(36).slice(2, 9);
  const begin = `[[EXK-B-${token}]]`;
  const end = `[[EXK-E-${token}]]`;
  if (!injectText(pid, buildPrompt(begin, end))) return { success: false, error: 'inject failed' };

  const deadline = Date.now() + config.PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(config.PROBE_POLL_MS);
    const f = readFrame(pid);
    if (frameHasReport(f, end)) {
      const report = extractReport(f, begin, end);
      if (report) return { success: true, report, marker: end };
      // standalone end marker present but couldn't parse — give it another cycle.
    }
  }
  return { success: false, error: 'probe timed out waiting for report' };
}
