// =============================================================================
// stepLog.js — one readable log line per thing made, and per AI call that did not simply work.
// =============================================================================
//
// Measured 19 Nov 2026: the Render log said "made=4 notFound=1" for a /parts request but not WHICH
// parts, how long each took or whether one was redone; the catalog routes printed loose blocks
// ("===== MODEL SELECTED =====") that could not be told apart between requests; and the first
// key=value version of these lines was hard to read - two 36-character ids on every line and
// Gemini's raw JSON pasted into the reason. Every line is now a short sentence:
//
//   [DesignStudio] parts NECK · made in 35.7s · 1 try · check passed · low detail · cut 380x198 · BLOUSE · job 1335562a
//   [DesignStudio] parts BACK · not in the photo · BLOUSE · job 1335562a
//   [AI] parts FRONT · image try 1/3 failed, retrying in 2.4s · Gemini busy (HTTP 503): This model is currently experiencing high demand · job 1335562a
//   [AI] parts FRONT · image OK on try 2 (22.8s) · job 1335562a
//   [Catalog] women side · made in 14.2s · SAREE · job 9f2c41d0
//
// The job (or request) is its first 8 characters - enough to find every line of one job. Only short
// values are logged: never an image, a key or a person's photo. Values are cut and stripped of line
// breaks, so a caller cannot forge or flood log lines.

const { AsyncLocalStorage } = require('node:async_hooks');

const MAX_VALUE = 160;
const SEP = ' · ';

// ── The request a line belongs to ────────────────────────────────────────────
// Every AI call deep inside a pipeline (an image attempt, a check, a part finder) logs its own
// failures and retries. It cannot be handed the requestId, jobId and item through every function,
// so the request carries them: set once at the door (contextMiddleware), filled in by the
// handler (setContext: requestId, jobId, endpoint), narrowed per item (withContext: the view,
// part or size being made - work that runs side by side gets its own copy).
const context = new AsyncLocalStorage();

/** Express middleware: every request gets its own, empty context. */
function contextMiddleware(req, _res, next) {
  context.run({ account: req.account || undefined }, next);
}

/** Add to the current request's context (seen by everything that request does from now on). */
function setContext(fields) {
  const store = context.getStore();
  if (store) Object.assign(store, fields);
}

/** Run fn with extra context (an item), without changing the context of work running beside it. */
function withContext(fields, fn) {
  return context.run({ ...(context.getStore() || {}), ...fields }, fn);
}

const currentContext = () => context.getStore() || {};

// ── Formatting ───────────────────────────────────────────────────────────────
const has = (v) => v !== undefined && v !== null && v !== '';
const clean = (v) => String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE);
const short = (id) => (has(id) ? clean(id).slice(0, 8) : null);

/**
 * An upstream error in one plain phrase: Gemini's own message instead of its JSON, the first
 * sentence only, and our internal kind ("busy: image model busy") said as "Gemini busy".
 */
function cleanReason(text) {
  let t = String(text);
  const message = t.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const before = t.split('{')[0].trim();
  if (message) t = `${before}${before ? ': ' : ''}${message[1]}`;
  t = t.replace(/\\[nrt"]/g, ' ').replace(/[{}"]/g, ' ')
    .replace(/^(busy|timeout|no_image):\s*/i, '')
    .replace(/\bthe image model\b/gi, 'Gemini').replace(/\bimage model\b/gi, 'Gemini')
    .replace(/Gemini busy:?\s*Gemini busy/i, 'Gemini busy');
  t = clean(t);
  const stop = t.indexOf('. ', 30);
  if (stop > 0) t = t.slice(0, stop);
  return t.replace(/[.:,\s]+$/, '').slice(0, 140);
}

/** The words for one check result from checkWord(): passed, skipped, failed(a,b). */
function checkPhrase(word) {
  const w = String(word);
  if (w === 'passed') return 'check passed';
  if (w === 'skipped') return 'check skipped';
  const m = w.match(/^failed\((.*)\)$/);
  return m ? `check failed: ${m[1].split(',').filter(Boolean).join(', ')}` : `check ${w}`;
}

const tries = (n) => (n === 1 ? '1 try' : `${n} tries`);

/** What happened, as the first words after the item. Returns [phrase, keys it used]. */
function outcome(f) {
  const s = has(f.seconds) ? f.seconds : null;
  switch (f.result) {
    case 'made': return [`made${s !== null ? ` in ${s}s` : ''}`, ['seconds']];
    case 'not_in_photo': return ['not in the photo', []];
    case 'too_small': return [`too small in the photo${has(f.px) ? ` (${f.px}px)` : ''}`, ['px']];
    case 'plain_cut': return ['plain cut sent (no AI asked)', []];
    case 'plain_cut_ai_failed': return ['AI failed - plain cut from the photo sent', []];
    case 'started': return ['started', []];
    case 'complete': return [`complete${s !== null ? ` in ${s}s` : ''}`, ['seconds']];
    case 'cancelled': return [`cancelled${s !== null ? ` after ${s}s` : ''}`, ['seconds']];
    case 'failed': return [`FAILED${s !== null ? ` after ${s}s` : ''}`, ['seconds']];
    case 'advised': return [`advised size ${has(f.size) ? f.size : '?'}${s !== null ? ` in ${s}s` : ''}`, ['size', 'seconds']];
    default: return [has(f.result) ? clean(f.result) : '', []];
  }
}

// The details after the outcome, in this order, each as a few words.
const DETAILS = [
  ['attempts', (v) => (Number(v) > 0 ? tries(Number(v)) : null)],
  ['check', (v) => checkPhrase(v)],
  ['redone', () => 'redone once'],
  ['sameAs', (v) => `same picture as ${clean(v)}`],
  ['lowDetail', () => 'low detail'],
  ['ownPhoto', () => "on the customer's photo"],
  ['cut', (v) => `cut ${clean(v)}`],
  ['size', (v) => clean(v)],
  ['views', (v) => `${v} views`],
  ['made', (v) => `${v} made`],
  ['failed', (v) => `${v} failed`],
  ['sizes', (v) => `sizes ${clean(v)}`],
  ['sizeType', (v) => clean(v)],
  ['tops', (v) => `${v} tops`],
  ['model', (v) => `model ${clean(v)}`],
  ['colour', (v) => `colour ${clean(v)}`],
  ['garment', (v) => clean(v)],
  ['group', (v) => clean(v)],
  ['code', (v) => `error ${clean(v)}`],
  ['error', (v) => `error ${clean(v)}`],
  ['why', (v) => clean(v)]
];
const IDENTITY = new Set(['endpoint', 'item', 'result', 'requestId', 'jobId', 'account']);

function tail(f) {
  const id = has(f.jobId) ? `job ${short(f.jobId)}` : has(f.requestId) ? `req ${short(f.requestId)}` : null;
  return [id, has(f.account) ? `acct ${short(f.account)}` : null].filter(Boolean);
}

function render(area, head, words, f) {
  console.log(`[${area}] ${[head, ...words, ...tail(f)].filter(Boolean).join(SEP)}`);
}

/**
 * One line for one thing delivered (a view, a part, a size) or a job starting or ending.
 * @param {string} area   e.g. 'DesignStudio', 'Catalog'
 * @param {Object} fields endpoint, item, result, then any details; null, undefined and '' are left out
 */
function stepLog(area, fields) {
  const f = Object.fromEntries(Object.entries(fields).filter(([, v]) => has(v)));
  const [what, used] = outcome(f);
  const seen = new Set([...IDENTITY, ...used]);
  const words = [what];
  for (const [key, say] of DETAILS) {
    if (!has(f[key]) || seen.has(key)) continue;
    seen.add(key);
    words.push(say(f[key]));
  }
  if (has(f.reason)) { seen.add('reason'); words.push(cleanReason(f.reason)); }
  for (const [key, value] of Object.entries(f)) if (!seen.has(key)) words.push(`${key} ${clean(value)}`);
  render(area, [f.endpoint, f.item].filter(has).map(clean).join(' '), words.filter(Boolean), f);
}

/** Seconds since a Date.now() timestamp, to one decimal. */
const secondsSince = (startedAt) => Math.round((Date.now() - startedAt) / 100) / 10;

/**
 * A check result in one word: passed, failed(...), or skipped. Takes either one check
 * ({ checked, passed, failures }, as /parts) or a Design Studio quality object holding several
 * ({ inspection: {...}, references: {...}, photo: {...}, regenerated }).
 */
function checkWord(quality) {
  if (!quality) return 'skipped';
  if ('passed' in quality) {
    if (quality.checked === false || quality.passed === null || quality.passed === undefined) return 'skipped';
    if (quality.passed) return 'passed';
    return `failed(${(quality.failures || []).map((f) => f.check || f.id).filter(Boolean).join(',')})`;
  }
  const checks = Object.entries(quality).filter(([, v]) => v && typeof v === 'object' && 'passed' in v && v.checked !== false && v.passed !== null);
  if (!checks.length) return 'skipped';
  const failed = checks.filter(([, v]) => v.passed === false);
  if (!failed.length) return 'passed';
  return `failed(${failed.map(([name, v]) => `${name}:${(v.failures || []).map((f) => f.check || f.id).filter(Boolean).join('+')}`).join(',')})`;
}

/**
 * One line for one AI call that did not simply succeed. The request's job and item come from
 * the context. result: retrying | gave_up | failed (not retried: a refusal, a bad request, a
 * spending cap) | ok_after_retry | skipped (an optional step left out, e.g. a check) | partial.
 */
function aiLog(fields) {
  const c = currentContext();
  const f = { requestId: c.requestId, jobId: c.jobId, endpoint: c.endpoint, item: c.item, account: c.requestId ? undefined : c.account,
    ...Object.fromEntries(Object.entries(fields).filter(([, v]) => has(v))) };
  const call = clean(f.call || 'AI call');
  const n = has(f.attempt) ? `${f.attempt}${has(f.of) ? `/${f.of}` : ''}` : null;
  const s = has(f.seconds) ? f.seconds : null;
  const what = {
    retrying: `${call}${n ? ` try ${n}` : ''} failed, retrying${has(f.waitSeconds) ? ` in ${f.waitSeconds}s` : ''}`,
    gave_up: `${call}${n ? ` try ${n}` : ''} failed - GIVING UP`,
    failed: `${call} FAILED (not retried)`,
    ok_after_retry: `${call} OK on try ${has(f.attempt) ? f.attempt : '?'}${s !== null ? ` (${s}s)` : ''}`,
    skipped: `${call} skipped`,
    partial: `${call} only partly answered`
  }[f.result] || `${call} ${clean(f.result || '')}`;
  const words = [what];
  if (has(f.reason)) words.push(cleanReason(f.reason));
  if (has(f.code)) words.push(`error ${clean(f.code)}`);
  if (has(f.part)) words.push(`part ${clean(f.part)}`);
  if (has(f.photo)) words.push(`photo ${clean(f.photo)}`);
  if (has(f.pictures)) words.push(`${f.pictures} pictures`);
  if (has(f.provider)) words.push(clean(f.provider));
  if (s !== null && f.result !== 'ok_after_retry') words.push(`after ${s}s`);
  if (has(f.why)) words.push(clean(f.why));
  render('AI', [f.endpoint, f.item].filter(has).map(clean).join(' '), words, f);
}

module.exports = { stepLog, secondsSince, checkWord, aiLog, cleanReason, contextMiddleware, setContext, withContext, currentContext, MAX_VALUE };
