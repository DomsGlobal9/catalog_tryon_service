// =============================================================================
// rateLimit.js — Per-customer budget of search-provider calls.
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
// WHO IS COUNTED: the caller passes a bucket - the gateway customer when known,
// so sending a different clientId each time does not reset the budget.
//
// WHERE: across all servers when the host supplied shared state
// (sharedState.js), otherwise in this process's memory.
//
const { config } = require('../discovery.config');
const { RateLimitError } = require('../lib/errors');
const { getSharedState } = require('../sharedState');

const WINDOW_SEC = 60;

/** @type {Map<string, { count: number, windowStart: number }>} */
const buckets = new Map();

/** Drop windows that have already expired so the map cannot grow without bound. */
function sweep(now) {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_SEC * 1000) buckets.delete(key);
  }
}

function consumeLocal(bucketKey, cost, limit) {
  const now = Date.now();
  if (buckets.size > 10_000) sweep(now);

  let bucket = buckets.get(bucketKey);
  if (!bucket || now - bucket.windowStart >= WINDOW_SEC * 1000) {
    bucket = { count: 0, windowStart: now };
    buckets.set(bucketKey, bucket);
  }

  const retryAfterSec = Math.max(1, Math.ceil((bucket.windowStart + WINDOW_SEC * 1000 - now) / 1000));
  if (bucket.count + cost > limit) return { allowed: false, used: bucket.count, limit, retryAfterSec };
  bucket.count += cost;
  return { allowed: true, used: bucket.count, limit, retryAfterSec };
}

/**
 * Spend `cost` provider calls from a budget.
 *
 * Refuses BEFORE charging: a request that would overflow the budget uses none of
 * it, so a client refused for a four-source search can still run a one-source one.
 *
 * @returns {Promise<RateLimitError|null>}  null when the calls may go ahead.
 */
async function charge(bucketKey, cost) {
  if (!bucketKey || !(cost > 0)) return null;

  const limit = config.rateLimit.perMinute;
  const shared = getSharedState();
  const outcome = shared
    ? await shared.consume(bucketKey, cost, { limit, windowSec: WINDOW_SEC })
    : consumeLocal(bucketKey, cost, limit);

  if (outcome.allowed) return null;

  const left = Math.max(0, limit - outcome.used);
  return new RateLimitError(
    `Search rate limit exceeded: this search needs ${cost} provider call${cost === 1 ? '' : 's'} ` +
    `and ${left} of ${limit}/min remain. Retry in ${outcome.retryAfterSec}s.`,
    outcome.retryAfterSec
  );
}

function reset() {
  buckets.clear();
}

module.exports = { charge, reset };
