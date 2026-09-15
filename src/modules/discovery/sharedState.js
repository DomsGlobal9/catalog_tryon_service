// =============================================================================
// sharedState.js — optional cross-server backing, supplied by the host app.
// =============================================================================
//
// Discovery imports nothing from the rest of src/. When the service runs on
// several servers, src/index.js hands in an adapter so the search budget and the
// search cache are shared between them:
//
//   consume(bucket, cost, { limit, windowSec })
//        -> { allowed, used, limit, retryAfterSec }
//   cacheGet(key)            -> { value, expiresAt } | null
//   cacheHasMany(keys)       -> Set of keys present
//   cacheSet(key, value, ttlSec)
//
// Without an adapter (tests, or a standalone discovery) everything runs in
// memory exactly as before. Cache methods may throw; callers treat a throw as a
// miss, so a database problem never fails a search.
//
let adapter = null;

function useSharedState(next) {
  adapter = next || null;
}

function getSharedState() {
  return adapter;
}

module.exports = { useSharedState, getSharedState };
