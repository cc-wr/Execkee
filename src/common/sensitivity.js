import { createHash } from 'node:crypto';
import config from './config.js';
import { claudeRun } from './exec-async.js';
import { readJsonSafe, atomicWriteJson } from './safe-fs.js';
import { isSensitiveHidden } from './store.js';

// Sensitivity coding for everything the BROWSER DASHBOARD displays. An LLM pass tags
// each display-bound string as sensitive or not; when the "hide sensitive" flag is on,
// cowork STRIPS the tagged items before writing dashboard-data.json, so the payload
// never carries them at all (hiding only in the page would leave the text sitting in
// the JSON). The controlling session flips the flag via `execkee sensitive hide|show`.
//
// Design points that are deliberate, not incidental:
//   - Cache-first. Classification is keyed by a hash of the NORMALIZED text, so an
//     unchanged item is classified once ever, not once per cycle. A cycle typically
//     sends only the handful of genuinely-new strings.
//   - Fail CLOSED. If the model is unavailable or its output won't parse, the
//     uncached text is treated as SENSITIVE. During an outage the dashboard hides
//     too much rather than leaking a therapy appointment.
//   - Manual overrides win permanently. The classifier is fallible and its mistakes
//     must be correctable: `sensitive mark|unmark` writes an override that no later
//     classification can overturn.
//   - Scope is the browser dashboard ONLY. CLI output, the cycle report, and the
//     controlling session are untouched.

const CACHE_VERSION = 1;

function emptyCache() {
  return { version: CACHE_VERSION, entries: {}, overrides: {} };
}

function readCache() {
  const c = readJsonSafe(config.SENSITIVITY_FILE, emptyCache(), config.SENSITIVITY_FILE);
  if (!c || c.version !== CACHE_VERSION) return emptyCache();
  c.entries = c.entries || {};
  c.overrides = c.overrides || {};
  return c;
}

function writeCache(c) {
  atomicWriteJson(config.SENSITIVITY_FILE, c);
}

// Normalize before hashing so trivial whitespace/case churn doesn't force a
// re-classification of text that is substantively the same string.
function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

export function keyOf(text) {
  return createHash('sha1').update(norm(text)).digest('hex').slice(0, 16);
}

const RULES = [
  'health, medical, or clinical content — appointments, symptoms, diagnoses, medication, providers, test results, insurance claims',
  'therapy or mental-health content — sessions, therapists, topics discussed, emotional state',
  'ANY personal name of a human being (first name, full name, or nickname). Treat every human name as sensitive, without exception and regardless of context.',
  'personal relationships, family matters, and private social plans',
];

function buildPrompt(items) {
  return [
    'You are a privacy classifier for a personal status dashboard. For each numbered item,',
    'decide whether it is POTENTIALLY SENSITIVE — content the user would not want visible',
    'to someone glancing at a dashboard screen.',
    '',
    'Treat an item as sensitive if it involves any of:',
    ...RULES.map((r, i) => `${i + 1}. ${r}`),
    '',
    'Ordinary work, software, build, or errand items with NO personal name and no health or',
    'therapy content are NOT sensitive.',
    'When genuinely uncertain, answer sensitive:true — over-hiding is preferred to leaking.',
    '',
    'Reply with ONLY a JSON array, one object per item, in the same order:',
    '[{"i":1,"sensitive":true,"kind":"health"},...]',
    'kind must be one of: health, therapy, person, personal, none.',
    '',
    'Items:',
    ...items.map((t, i) => `${i + 1}. ${String(t).replace(/\s+/g, ' ').slice(0, 400)}`),
  ].join('\n');
}

function parseVerdicts(output, count) {
  let text = String(output || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) text = arr[0];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const out = new Array(count).fill(null);
  for (const o of parsed) {
    if (!o || typeof o !== 'object') continue;
    const idx = Number(o.i) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= count) continue;
    out[idx] = { sensitive: !!o.sensitive, kind: String(o.kind || 'none') };
  }
  return out;
}

// Classify every string in `texts`, consulting (and filling) the cache. Returns a Map
// of key -> {sensitive, kind}. Overrides are applied last so they always win.
export async function classify(texts) {
  const cache = readCache();
  const result = new Map();
  const pending = new Map(); // key -> text, deduped

  for (const t of texts || []) {
    const text = String(t == null ? '' : t);
    if (!norm(text)) continue;
    const k = keyOf(text);
    if (result.has(k) || pending.has(k)) continue;
    if (cache.entries[k]) result.set(k, cache.entries[k]);
    else pending.set(k, text);
  }

  if (pending.size) {
    const keys = [...pending.keys()];
    const items = [...pending.values()];
    let verdicts = null;
    try {
      const out = await claudeRun(
        ['-p', '--no-session-persistence', buildPrompt(items)],
        { timeout: config.SENSITIVITY_TIMEOUT_MS }
      );
      verdicts = parseVerdicts(out, items.length);
      if (!verdicts) console.error('[sensitivity] unparseable classifier output — failing closed');
    } catch (err) {
      console.error(`[sensitivity] classification failed (${err.message}) — failing closed`);
    }
    for (let i = 0; i < keys.length; i++) {
      // Fail closed: no verdict for this item => treat as sensitive. Do NOT cache a
      // failed verdict, so the next cycle retries instead of freezing a false positive.
      const v = verdicts && verdicts[i];
      if (v) cache.entries[keys[i]] = v;
      result.set(keys[i], v || { sensitive: true, kind: 'unclassified' });
    }
    try { writeCache(cache); } catch (err) { console.error(`[sensitivity] cache write failed: ${err.message}`); }
  }

  for (const [k, v] of Object.entries(cache.overrides)) {
    if (result.has(k)) result.set(k, { sensitive: !!v.sensitive, kind: v.kind || 'override' });
  }
  return result;
}

// Synchronous cache/override lookup — no LLM call. Used by the strip pass after
// classify() has populated the cache. Unknown text is sensitive (fail closed).
export function lookup(text, verdicts) {
  const k = keyOf(text);
  if (verdicts && verdicts.has(k)) return verdicts.get(k);
  const cache = readCache();
  if (cache.overrides[k]) return { sensitive: !!cache.overrides[k].sensitive, kind: 'override' };
  return cache.entries[k] || { sensitive: true, kind: 'unclassified' };
}

export function isSensitive(text, verdicts) {
  return !!lookup(text, verdicts).sensitive;
}

// Force an item sensitive (true) or not (false), permanently. Keyed by text so it
// survives id churn (a presumed task is re-derived with a new id every cycle).
export function setOverride(text, sensitive) {
  const cache = readCache();
  cache.overrides[keyOf(text)] = { sensitive: !!sensitive, text: String(text).slice(0, 200) };
  writeCache(cache);
}

export function clearOverride(text) {
  const cache = readCache();
  delete cache.overrides[keyOf(text)];
  writeCache(cache);
}

// ---- Dashboard strip ----

// Every display-bound string in a dashboard-data payload. Kept in one place so a new
// dashboard field can't silently bypass the filter — add it here when you add it there.
function dashboardTexts(data) {
  const texts = [];
  if (data.sentence && data.sentence.text) texts.push(data.sentence.text);
  for (const key of ['dailyTasks', 'coverageTasks', 'presumedTasks']) {
    for (const t of data[key] || []) if (t && t.text) texts.push(t.text);
  }
  for (const e of data.flaggedEvents || []) {
    if (e && e.name) texts.push(e.name);
    if (e && e.error) texts.push(e.error);
  }
  for (const i of data.instanceStatus || []) if (i && i.name) texts.push(i.name);
  return texts;
}

// Remove (not mask) every sensitive item from a dashboard-data payload, in place.
// Removal is deliberate: the payload itself must not carry the text, since hiding only
// in the page would leave it readable in dashboard-data.json. Counts/donut in the page
// are derived from these arrays, so they recompute from the visible set automatically —
// no stale total left behind to advertise that something was hidden.
//
// No-op when the flag is off (the default), so the normal dashboard is unaffected and
// no classifier call is made.
// Populate the cache for everything a dashboard payload displays. Does NOT modify the
// payload — the strip happens later, at the browser boundary only (see below). Run from
// the cowork cycle and from `sensitive hide`, so the cache is warm before the page asks.
// Skipped entirely when the flag is off, so the default costs nothing.
export async function classifyDashboard(data) {
  if (!data || !isSensitiveHidden()) return;
  try {
    await classify(dashboardTexts(data));
  } catch (err) {
    console.error(`[sensitivity] classify threw (${err.message}) — failing closed`);
  }
}

// Strip sensitive items from a payload bound for the BROWSER. Applied at the two
// browser read points (the SSE snapshot and pushUpdate) and nowhere else — that is what
// keeps the scope to the browser dashboard: the stored JSON and every CLI surface still
// carry the full data, exactly as before.
//
// Synchronous and cache-only by design. The SSE path can't await a classifier call, and
// shouldn't: a not-yet-classified item must not flash onto the screen. Uncached text is
// therefore treated as sensitive and withheld until a cycle classifies it — fail-closed
// in the direction that matters.
export function applySensitivityToDashboardSync(data) {
  if (!data || !isSensitiveHidden()) return data;
  const cache = readCache();
  const verdicts = new Map();
  for (const t of dashboardTexts(data)) {
    const k = keyOf(t);
    const ov = cache.overrides[k];
    verdicts.set(k, ov ? { sensitive: !!ov.sensitive, kind: 'override' }
                       : (cache.entries[k] || { sensitive: true, kind: 'unclassified' }));
  }
  return stripInto(data, verdicts);
}

function stripInto(data, verdicts) {
  // An absent/empty field is NOT a sensitivity signal — only classify real text.
  // (Without this guard an event with no `error` would hash to the empty string, miss
  // the cache, and be dropped by the fail-closed default.)
  const sensitive = (t) => !!norm(t) && isSensitive(t, verdicts);
  const keep = (arr, pick) => (arr || []).filter(x => !pick(x).some(sensitive));

  if (data.sentence && data.sentence.text && sensitive(data.sentence.text)) {
    data.sentence = null;
    data.standby = true; // the page shows "Stand by." rather than an empty slot
  }
  data.dailyTasks = keep(data.dailyTasks, t => [t && t.text]);
  data.coverageTasks = keep(data.coverageTasks, t => [t && t.text]);
  data.presumedTasks = keep(data.presumedTasks, t => [t && t.text]);
  data.flaggedEvents = keep(data.flaggedEvents, e => [e && e.name, e && e.error]);
  data.instanceStatus = keep(data.instanceStatus, i => [i && i.name]);
  data.sensitiveHidden = true;
  return data;
}

export function listOverrides() {
  const cache = readCache();
  return Object.entries(cache.overrides).map(([k, v]) => ({ key: k, sensitive: !!v.sensitive, text: v.text || '' }));
}
