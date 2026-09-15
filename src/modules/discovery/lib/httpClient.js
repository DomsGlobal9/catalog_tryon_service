// =============================================================================
// httpClient.js — Small fetch wrapper with a hard timeout and bounded retries.
// =============================================================================
//
// Deliberately local to the discovery module rather than shared with the
// generation pipeline: that one needs long-lived, retrying, abortable calls to
// Gemini, while this one needs short, fail-fast calls to a search API.
//
const { ProviderError } = require('./errors');
const { redact } = require('./redact');

/** Statuses worth one more try: the provider is overloaded, not refusing us. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Longest Retry-After we will honour; anything longer fails now instead. */
const MAX_RETRY_AFTER_MS = 5000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS) : null;
}

function providerError(message, { retryable = false, waitMs = null, details } = {}) {
  const err = new ProviderError(message, details);
  err.retryable = retryable;
  err.retryAfterMs = waitMs;
  return err;
}

/** One request. Throws ProviderError, marked retryable where a retry can help. */
async function attempt(url, { headers, body, timeoutMs, providerName }) {
  let response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    // AbortSignal.timeout() rejects with a TimeoutError DOMException. A timeout
    // is NOT retried: it already used the whole time budget, and a second one
    // would double the wait for a provider that is evidently struggling.
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw providerError(`${providerName} did not respond within ${timeoutMs}ms.`);
    }
    // A dropped connection or DNS blip usually is transient.
    throw providerError(
      `${providerName} request failed: ${redact(err && err.message ? err.message : String(err))}`,
      { retryable: true }
    );
  }

  if (!response.ok) {
    // Read the body for diagnostics, but never surface it verbatim — it is
    // third-party text and could echo back anything we sent.
    let detail = '';
    try {
      detail = redact((await response.text()).slice(0, 300));
    } catch {
      detail = '<unreadable body>';
    }

    if (response.status === 401 || response.status === 403) {
      throw providerError(`${providerName} rejected our credentials.`);
    }
    const retryable = RETRYABLE_STATUS.has(response.status);
    const waitMs = retryAfterMs(response.headers.get('retry-after'));
    if (response.status === 429) {
      throw providerError(`${providerName} quota or rate limit exhausted.`, { retryable, waitMs });
    }
    throw providerError(`${providerName} returned HTTP ${response.status}.`, { retryable, waitMs, details: detail || undefined });
  }

  try {
    return await response.json();
  } catch {
    throw providerError(`${providerName} returned a malformed JSON response.`);
  }
}

/**
 * POST JSON and parse a JSON response, with a wall-clock timeout per attempt and
 * up to `retries` extra attempts for failures that a retry can fix.
 *
 * Every failure path throws ProviderError (424) rather than bubbling a raw
 * network error, so a provider outage can never reach the caller as a 5xx.
 *
 * @param {string} url
 * @param {Object}   options
 * @param {Object}   options.headers
 * @param {Object}   options.body          Serialized as JSON.
 * @param {number}   options.timeoutMs     Per attempt.
 * @param {string}   options.providerName  Used only in error messages.
 * @param {number}   [options.retries=0]
 * @param {number}   [options.retryBaseMs=500]  Wait before retry n is base*2^n + up to 250ms.
 * @param {Function} [options.sleep]       Injected by tests.
 * @returns {Promise<Object>} Parsed JSON body.
 */
async function postJson(url, {
  headers = {}, body, timeoutMs = 8000, providerName = 'provider',
  retries = 0, retryBaseMs = 500, sleep = defaultSleep
} = {}) {
  for (let tryNo = 0; ; tryNo++) {
    try {
      return await attempt(url, { headers, body, timeoutMs, providerName });
    } catch (err) {
      if (!err.retryable || tryNo >= retries) {
        if (tryNo > 0) err.message = `${err.message} (after ${tryNo + 1} attempts)`;
        throw err;
      }
      const backoff = retryBaseMs * 2 ** tryNo + Math.floor(Math.random() * 250);
      await sleep(err.retryAfterMs != null ? Math.max(err.retryAfterMs, backoff) : backoff);
    }
  }
}

module.exports = { postJson, RETRYABLE_STATUS };
