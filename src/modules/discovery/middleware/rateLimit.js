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
 */
function searchRateLimit(req, _res, next) {
  const clientId = req.validated && req.validated.clientId;
  if (!clientId) return next();

  const now = Date.now();
  if (buckets.size > 10_000) sweep(now);

  let bucket = buckets.get(clientId);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    buckets.set(clientId, bucket);
  }

  bucket.count += 1;

  if (bucket.count > config.rateLimit.perMinute) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000));
    return next(
      new RateLimitError(
        `Search rate limit exceeded (${config.rateLimit.perMinute}/min). Retry in ${retryAfterSec}s.`,
        retryAfterSec
      )
    );
  }

  next();
}

function reset() {
  buckets.clear();
}

module.exports = { searchRateLimit, reset };
