// =============================================================================
// rateLimit.js — Per-client fixed-window limiter for discovery searches.
// =============================================================================
//
// PURPOSE: protecting the Serper budget, not preventing abuse. The gateway
// already enforces 500 requests / 5 minutes per (client, slug) ahead of us.
// This is the narrower guard that stops one client burning through search
// credits.
//
// It counts every search request, including ones that will be served from
// cache. That is a deliberate simplification: it also caps CPU per client, and
// the default of 20/min is generous for a keyword search API.
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
 * Must be mounted AFTER validateBody — it reads req.validated.clientId.
 *
 * The budget is counted in PROVIDER CALLS, not requests: one search across four
 * sources makes four calls and costs four credits' worth of budget. Counting it
 * as one would let a client spend four times the intended amount.
 */
function searchRateLimit(req, _res, next) {
  const clientId = req.validated && req.validated.clientId;
  if (!clientId) return next();

  const cost = Array.isArray(req.validated.sources) && req.validated.sources.length
    ? req.validated.sources.length
    : 1;

  const now = Date.now();
  if (buckets.size > 10_000) sweep(now);

  let bucket = buckets.get(clientId);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    buckets.set(clientId, bucket);
  }

  // Refuse BEFORE charging: a request that would overflow the budget is rejected
  // without using any of it, so a client asking for four sources near the limit
  // can still retry with one.
  if (bucket.count + cost > config.rateLimit.perMinute) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000));
    const left = Math.max(0, config.rateLimit.perMinute - bucket.count);
    return next(
      new RateLimitError(
        `Search rate limit exceeded: this search needs ${cost} provider call${cost === 1 ? '' : 's'} ` +
        `and ${left} of ${config.rateLimit.perMinute}/min remain. Retry in ${retryAfterSec}s.`,
        retryAfterSec
      )
    );
  }

  bucket.count += cost;
  next();
}

function reset() {
  buckets.clear();
}

module.exports = { searchRateLimit, reset };
