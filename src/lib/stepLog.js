// =============================================================================
// stepLog.js — one clear log line per thing made, the same shape in every endpoint.
// =============================================================================
//
// Measured 19 Nov 2026: the Render log said "made=4 notFound=1" for a /parts request but not WHICH
// parts, how long each took or whether one was redone, and the catalog routes printed loose blocks
// ("===== MODEL SELECTED =====") that could not be told apart between requests. Every endpoint now
// writes, for every photo, view, size or part it delivers:
//
//   [DesignStudio] requestId=… jobId=… endpoint=parts item=NECK result=made seconds=21.4 attempts=1 check=passed
//
// Only short values are logged: never an image, a key or a person's photo. A value is cut to
// MAX_VALUE characters and stripped of line breaks, so a caller cannot forge or flood log lines.

const { AsyncLocalStorage } = require('node:async_hooks');

const MAX_VALUE = 160;

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

function format(value) {
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_VALUE);
  return /\s|"/.test(text) ? JSON.stringify(text) : text;
}

/**
 * @param {string} area   e.g. 'DesignStudio', 'Catalog', 'Discovery'
 * @param {Object} fields written in order; null, undefined and '' are left out
 */
function stepLog(area, fields) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${format(v)}`);
  console.log(`[${area}] ${parts.join(' ')}`);
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
 * One line for one AI call that did not simply succeed: a failure, a retry, giving up, or
 * success after a retry. The request's ids and item come from the context.
 *
 *   [AI] requestId=… jobId=… endpoint=parts item=NECK call=image model=gemini-3.1-flash-image
 *        attempt=1 of=3 result=retrying reason="busy (HTTP 503)" waitSeconds=2.4
 *
 * result: retrying | gave_up | failed (not retried: a refusal, a bad request) | ok_after_retry
 *         | skipped (an optional step that failed and was left out, e.g. a check)
 */
function aiLog(fields) {
  const c = currentContext();
  stepLog('AI', { requestId: c.requestId, jobId: c.jobId, endpoint: c.endpoint, item: c.item, account: c.requestId ? undefined : c.account, ...fields });
}

module.exports = { stepLog, secondsSince, checkWord, aiLog, contextMiddleware, setContext, withContext, currentContext, MAX_VALUE };
