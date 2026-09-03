// =============================================================================
// searchCache.js — In-process TTL + LRU cache for provider search results.
// =============================================================================
//
// The only piece of state in this module. It exists for one reason: Serper
// bills per search, and third parties repeat identical keyword queries
// constantly. A cache hit costs nothing and returns nothing stale enough to
// matter — web design results do not change minute to minute.
//
// LIMITATION, by design: this is per-process. It empties on restart and does
// not coordinate across instances. Promoting it to Redis is the obvious next
// step if this service is ever scaled horizontally.
//
const { config } = require('../discovery.config');

/** @type {Map<string, { value: any, expiresAt: number }>} */
const store = new Map();

const enabled = () => config.cache.ttlSec > 0;

function get(key) {
  if (!enabled()) return null;

  const entry = store.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }

  // Refresh recency: re-inserting moves the key to the end of Map iteration
  // order, so the eviction below always drops the least recently used entry.
  store.delete(key);
  store.set(key, entry);
  return entry.value;
}

function set(key, value) {
  if (!enabled()) return;

  if (store.has(key)) store.delete(key);
  store.set(key, { value, expiresAt: Date.now() + config.cache.ttlSec * 1000 });

  while (store.size > config.cache.maxEntries) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function clear() {
  store.clear();
}

function stats() {
  return { enabled: enabled(), size: store.size, maxEntries: config.cache.maxEntries, ttlSec: config.cache.ttlSec };
}

module.exports = { get, set, clear, stats };
