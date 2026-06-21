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

// True if the user has text typed into the input box (a half-composed message).
// CRITICAL: never inject while this is true, or the probe prompt is spliced into
// the user's keystrokes. The active input box is the LAST line beginning with '>';
// anything after the '>' means the user is composing. Errs toward "composing"
// (skip) on ambiguity, which is the safe direction.
function userComposing(frame) {
  const lines = frame.split('\n').map(clean).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('>')) continue;
    const rest = lines[i].slice(1).trim();
    if (!rest) return false;                         // empty input box
    if (/^Try\s+["'‘“]/.test(rest)) return false;    // idle placeholder hint: Try "…"
    return true;                                      // real user-typed text -> composing
  }
  return false;
}

// Volatile TUI chrome to ignore in BOTH the stability check and the "new content
// after the marker" check: status bar, token counter, rotating tip, and the
// post-response status footer like "Baked for 3s" (Claude Code's done-timer; the
// working words vary — Baking/Brewing/etc. — so match the "<word> for <N>s" shape).
// That footer slipping through made the unchanged-guard read it as a fresh turn, so
// the probe re-fired every cycle on an unchanged session (seen in the ProcessLink
// window: identical reports, one per cycle). Stateless (no /g) — safe to reuse.
const CHROME_RE = /shift\+tab|bypass permissions|\btokens\b|for agents|auto-accept|to interrupt|^\s*[a-z]+ for \d+(\.\d+)?s\b/i;

// Frame normalized for the stability check: drop the volatile bottom chrome (status
// bar, token counter, rotating tip) so a ticking counter doesn't prevent settling,
// but KEEP the conversation + input box so active typing/rendering breaks stability.
function idleStableNorm(frame) {
  return frame.split('\n').map(clean)
    .filter((l) => !CHROME_RE.test(l))
    .join('\n').replace(/\n{2,}/g, '\n').trim();
}

// Has the conversation advanced since our last probe? Chrome-agnostic check: scan the
// recent TAIL of the (cleaned) frame for the last probe's marker. If it's still there,
// only short chrome (input box, status bar, the "Baked for Ns" footer) sits below it
// => unchanged. A real new turn is long enough to push the marker up out of the tail
// => advanced. This avoids classifying TUI chrome line by line — which kept letting a
// new footer string defeat the guard and re-probe an unchanged session every cycle.
// Errs toward "unchanged/skip" for a very short new turn (caught a cycle later as more
// accumulates) — the safe direction, since the complaint was over-probing. clean()
// keeps the ASCII markers intact while dropping box-drawing, so the tail char-count
// is stable.
function hasNewContentAfter(frame, marker) {
  if (!marker) return true;
  const cleaned = frame.split('\n').map(clean).join('\n');
  return !cleaned.slice(-config.PROBE_UNCHANGED_TAIL_CHARS).includes(marker);
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
//   { success:false, skipped:true, reason }      — busy / awaiting-user: retry later
//   { success:false, fallback:true, error }      — TUI did NOT behave as expected;
//                                                  caller should use the fork report
// The fallback path is the validation: every way the live-window round-trip can
// misbehave (can't read the frame, never reaches a ready state, the injected prompt
// isn't accepted, or no report arrives) returns fallback:true so report() reverts
// to the on-disk fork report instead of producing a bad/empty report or hanging.
export async function probeReport(inst, { lastMarker } = {}) {
  const pid = inst && inst.pid;
  if (!probeSupported) return { success: false, fallback: true, error: 'probe not supported on this platform' };
  if (!pid) return { success: false, fallback: true, error: 'no pid' };

  const first = readFrame(pid);
  if (!first || first.startsWith('ATTACH_FAIL')) {
    return { success: false, fallback: true, error: `cannot read console frame (${(first || '').trim() || 'empty'})` };
  }

  // Settle to a genuinely-idle, user-not-interacting state before injecting:
  //   - not generating (isBusy), TUI up (looksReady), not at a permission prompt;
  //   - the input box is EMPTY — the user is not composing a message (NEVER inject
  //     into half-typed input; this is the bug that spliced the probe prompt into
  //     the user's keystrokes);
  //   - the frame is UNCHANGED vs the previous sample (ignoring the volatile status
  //     bar), so we don't inject while the user is actively typing or the model is
  //     mid-render. Two identical idle frames => stable idle.
  let settled = null;
  let prevNorm = null;
  for (let i = 0; i < config.PROBE_SETTLE_SAMPLES; i++) {
    await sleep(config.PROBE_IDLE_SETTLE_MS);
    const cur = readFrame(pid);
    if (cur.startsWith('ATTACH_FAIL')) return { success: false, fallback: true, error: 'console detached mid-probe' };
    const idleNow = !isBusy(cur) && looksReady(cur) && !isInteractivePrompt(cur) && !userComposing(cur);
    const norm = idleStableNorm(cur);
    if (idleNow && prevNorm !== null && norm === prevNorm) { settled = cur; break; }
    prevNorm = idleNow ? norm : null; // reset the anchor whenever it isn't idle
  }
  if (!settled) {
    // Busy / awaiting-user / user-composing are EXPECTED transient states — skip and
    // retry next cycle (never disturb a window the user is in). Anything else means
    // the TUI never reached a stable idle state — fall back to the fork report.
    const cur = readFrame(pid);
    if (isBusy(cur)) return { success: false, skipped: true, reason: 'instance is mid-inference' };
    if (isInteractivePrompt(cur)) return { success: false, skipped: true, reason: 'instance is at an interactive prompt (permission/trust)' };
    if (userComposing(cur)) return { success: false, skipped: true, reason: 'user is composing input' };
    return { success: false, fallback: true, error: 'TUI never reached a stable idle state' };
  }
  if (lastMarker && !hasNewContentAfter(settled, lastMarker)) return { success: false, unchanged: true };

  const token = Math.random().toString(36).slice(2, 9);
  const begin = `[[EXK-B-${token}]]`;
  const end = `[[EXK-E-${token}]]`;
  if (!injectText(pid, buildPrompt(begin, end))) return { success: false, fallback: true, error: 'inject failed' };

  // VALIDATE the round-trip: confirm the injection was accepted and the model began
  // responding (it went busy, or a marker line appeared) within PROBE_ACCEPT_MS. If
  // not — e.g. the prompt never submitted, or this isn't a normal claude TUI — bail
  // fast to the fork report rather than waiting out the full timeout.
  const started = Date.now();
  const acceptBy = started + config.PROBE_ACCEPT_MS;
  const deadline = started + config.PROBE_TIMEOUT_MS;
  let accepted = false;
  while (Date.now() < deadline) {
    await sleep(config.PROBE_POLL_MS);
    const f = readFrame(pid);
    if (f.startsWith('ATTACH_FAIL')) return { success: false, fallback: true, error: 'console detached during probe' };
    if (!accepted && (isBusy(f) || frameHasReport(f, begin) || frameHasReport(f, end))) accepted = true;
    if (frameHasReport(f, end)) {
      const report = extractReport(f, begin, end);
      if (report) return { success: true, report, marker: end };
      // standalone end marker present but not yet parseable — keep polling.
    }
    if (!accepted && Date.now() > acceptBy) {
      return { success: false, fallback: true, error: 'probe not accepted — TUI did not respond to the injected prompt' };
    }
  }
  return { success: false, fallback: true, error: 'probe timed out waiting for report' };
}
