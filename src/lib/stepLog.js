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

const MAX_VALUE = 160;

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

module.exports = { stepLog, secondsSince, checkWord, MAX_VALUE };
