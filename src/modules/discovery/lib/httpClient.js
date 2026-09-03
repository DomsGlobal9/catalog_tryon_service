// =============================================================================
// httpClient.js — Small fetch wrapper with a hard timeout.
// =============================================================================
//
// Deliberately local to the discovery module rather than shared with the
// generation pipeline: that one needs long-lived, retrying, abortable calls to
// Gemini, while this one needs short, fail-fast calls to a search API.
//
const { ProviderError } = require('./errors');
const { redact } = require('./redact');

/**
 * POST JSON and parse a JSON response, with a wall-clock timeout.
 *
 * Every failure path throws ProviderError (424) rather than bubbling a raw
 * network error, so a provider outage can never reach the caller as a 5xx.
 *
 * @param {string} url
 * @param {Object}  options
 * @param {Object}  options.headers
 * @param {Object}  options.body       Serialized as JSON.
 * @param {number}  options.timeoutMs
 * @param {string}  options.providerName  Used only in error messages.
 * @returns {Promise<Object>} Parsed JSON body.
 */
async function postJson(url, { headers = {}, body, timeoutMs = 8000, providerName = 'provider' } = {}) {
  let response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    // AbortSignal.timeout() rejects with a TimeoutError DOMException.
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new ProviderError(`${providerName} did not respond within ${timeoutMs}ms.`);
    }
    throw new ProviderError(`${providerName} request failed: ${redact(err && err.message ? err.message : String(err))}`);
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
      throw new ProviderError(`${providerName} rejected our credentials.`);
    }
    if (response.status === 429) {
      throw new ProviderError(`${providerName} quota or rate limit exhausted.`);
    }
    throw new ProviderError(`${providerName} returned HTTP ${response.status}.`, detail || undefined);
  }

  try {
    return await response.json();
  } catch {
    throw new ProviderError(`${providerName} returned a malformed JSON response.`);
  }
}

module.exports = { postJson };
