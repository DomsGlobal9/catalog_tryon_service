// =============================================================================
// publicError.js — what a caller may be told about a failure.
// =============================================================================
//
// Raw upstream text (Gemini's error bodies, Prisma's "can't reach database at
// host:port") is for our logs. A caller sees an error's own message only when
// the error says it is written for them (`expose`, set by body-parser's 4xx
// errors, ImageFetchError and InvalidColour); otherwise one plain sentence.
//
function publicMessage(err, fallback = 'Generation failed. Please try again.') {
  return err && err.expose && err.message ? err.message : fallback;
}

/** The HTTP status for a refused request: the error's own 4xx, else 500. */
function publicStatus(err) {
  const status = Number(err && (err.status || err.statusCode));
  return status >= 400 && status < 500 ? status : 500;
}

/**
 * A 429 that never clears on retry: the provider's spending cap or a daily quota.
 * Measured 15 Oct 2026: a spent monthly cap was retried 3 times and reported as "no
 * response after retries", and callers were told to try again. Not "billing": Google's
 * ordinary per-minute 429 mentions billing too, and that one clears in seconds.
 * @returns {Error|null}
 */
function providerLimitError(status, text) {
  if (status !== 429 || !/spending cap|spend cap|budget|exceeded its monthly|PerDay/i.test(text || '')) return null;
  const err = new Error('The AI provider has reached its spending limit for this service, so generation is unavailable until the limit is raised. Retrying will not help.');
  err.expose = true;
  err.code = 'PROVIDER_LIMIT_REACHED';
  return err;
}

module.exports = { publicMessage, publicStatus, providerLimitError };
