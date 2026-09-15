// =============================================================================
// rateLimit.js — Per-client budget of search-provider calls.
// =============================================================================
//
// PURPOSE: protecting the Serper budget, not preventing abuse. The gateway
// already enforces 500 requests / 5 minutes per (client, slug) ahead of us.
// This is the narrower guard that stops one client burning through credits.
//
// WHAT IS COUNTED: provider calls that will actually be made - not requests.
//
//   * A search across four sources makes four calls, so it costs four.
//   * A source already in the cache makes no call, so it costs nothing.
//
// The second rule is what makes changing a result filter, re-opening a page or
// reloading the UI genuinely free: those are answered from the cache, and they
// used to use up the budget anyway - five four-source clicks and a client was
// locked out for a minute without having spent a single credit. Requests that
// cost nothing are still bounded by the gateway's own request limit.
//
// LIMITATION, by design: in-process. Resets on restart, does not coordinate
// across instances. Move to Redis alongside searchCache if this is ever scaled out.
//
const { config } = require('../discovery.config');
const { RateLimitError } = require('../lib/errors');

const WINDOW_MS = 60_000;

/** @type {Map<string, { count: number, windowStart: number }>} */
const buckets = new Map();

/** Drop windows that have already expired so the map cannot grow without bound. */
function sweep(now) {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_MS) buckets.delete(key);
  }
}

/**
 * Spend `cost` provider calls from a client's budget.
 *
 * Refuses BEFORE charging: a request that would overflow the budget uses none of
 * it, so a client refused for a four-source search can still run a one-source one.
 *
 * @returns {RateLimitError|null}  null when the calls may go ahead.
 */
function charge(clientId, cost) {
  if (!clientId || !(cost > 0)) return null;

  const now = Date.now();
  if (buckets.size > 10_000) sweep(now);

  let bucket = buckets.get(clientId);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    buckets.set(clientId, bucket);
  }

  if (bucket.count + cost > config.rateLimit.perMinute) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000));
    const left = Math.max(0, config.rateLimit.perMinute - bucket.count);
    return new RateLimitError(
      `Search rate limit exceeded: this search needs ${cost} provider call${cost === 1 ? '' : 's'} ` +
      `and ${left} of ${config.rateLimit.perMinute}/min remain. Retry in ${retryAfterSec}s.`,
      retryAfterSec
    );
  }

  bucket.count += cost;
  return null;
}

function reset() {
  buckets.clear();
}

module.exports = { charge, reset };
