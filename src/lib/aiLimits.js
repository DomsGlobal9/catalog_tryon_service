// =============================================================================
// aiLimits.js — a Gemini "limit reached" refusal: final, or worth one more try after a wait?
// =============================================================================
//
// A 429 naming a spending cap, budget or daily quota used to be treated as final everywhere ("the
// limit will not clear on retry"). Measured 19 Nov 2026 in production: those refusals came and went
// within minutes - some calls passed, some were refused, and a part refused at 12:05 was made at
// 12:15. So a limit refusal is asked once more after a wait (Google's own retryDelay when it gives
// one, else QUOTA_WAIT_MS, never more than MAX_WAIT_MS); only a second refusal is final.

const LIMIT = /spending cap|spend cap|budget|exceeded its monthly|PerDay/i;
const QUOTA_WAIT_MS = Number(process.env.AI_QUOTA_RETRY_MS || 20000);
const MAX_WAIT_MS = 30000;

/** A 429 whose text names a limit (not an ordinary per-minute "busy"). */
const isLimit = (status, text) => status === 429 && LIMIT.test(String(text || ''));

/** How long to wait before the one retry: Google's RetryInfo "retryDelay": "17s", else the default. */
function quotaWaitMs(text) {
  const m = String(text || '').match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  const google = m ? Number(m[1]) * 1000 : null;
  return Math.round(Math.min(MAX_WAIT_MS, Math.max(Math.min(QUOTA_WAIT_MS, 1000), google !== null ? google : QUOTA_WAIT_MS)));
}

module.exports = { isLimit, quotaWaitMs, QUOTA_WAIT_MS, MAX_WAIT_MS };
