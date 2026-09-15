// =============================================================================
// searchCache.js — TTL + LRU cache for provider search results.
// =============================================================================
//
// It exists for one reason: Serper bills per search, and third parties repeat
// identical keyword queries constantly. A cache hit costs nothing and returns
// nothing stale enough to matter — web design results do not change minute to
// minute.
//
// Two tiers:
//   1. this process's memory - instant, checked first;
//   2. the shared cache, when the host supplied one (sharedState.js) - so a
//      search answered by one server is free on every other server too.
//
// The shared tier is a bonus, never a dependency: any failure there is treated
// as a miss, and writes to it never hold up a response.
//
const { config } = require('../discovery.config');
const { getSharedState } = require('../sharedState');

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

/**
 * Whether a live entry exists, WITHOUT refreshing its recency. Used to work out
 * what a search will cost before running it, so asking must not count as using.
 */
function has(key) {
  if (!enabled()) return false;
  const entry = store.get(key);
  return !!entry && Date.now() <= entry.expiresAt;
}

function setLocal(key, value, expiresAt) {
  if (store.has(key)) store.delete(key);
  store.set(key, { value, expiresAt });

  while (store.size > config.cache.maxEntries) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function set(key, value) {
  if (!enabled()) return;
  setLocal(key, value, Date.now() + config.cache.ttlSec * 1000);

  const shared = getSharedState();
  if (shared) {
    Promise.resolve()
      .then(() => shared.cacheSet(key, value, config.cache.ttlSec))
      .catch(() => {}); // a missed shared write only costs a future provider call
  }
}

/**
 * Look in the shared cache (memory has already missed). A hit is copied into
 * memory with its ORIGINAL expiry, so it is never kept longer than intended.
 * @returns {Promise<any|null>}
 */
async function getShared(key) {
  const shared = getSharedState();
  if (!enabled() || !shared) return null;
  try {
    const hit = await shared.cacheGet(key);
    if (!hit || hit.expiresAt <= Date.now()) return null;
    setLocal(key, hit.value, hit.expiresAt);
    return hit.value;
  } catch {
    return null;
  }
}

/**
 * The keys that are in neither tier - the searches that will really cost a
 * provider call. Memory is checked first; only its misses go to the shared tier.
 * @returns {Promise<string[]>}
 */
async function missing(keys) {
  if (!enabled()) return [...keys];
  const notLocal = keys.filter((k) => !has(k));
  const shared = getSharedState();
  if (!notLocal.length || !shared) return notLocal;
  try {
    const present = await shared.cacheHasMany(notLocal);
    return notLocal.filter((k) => !present.has(k));
  } catch {
    return notLocal;
  }
}

function clear() {
  store.clear();
}

function stats() {
  return {
    enabled: enabled(),
    shared: !!getSharedState(),
    size: store.size,
    maxEntries: config.cache.maxEntries,
    ttlSec: config.cache.ttlSec
  };
}

module.exports = { get, has, set, getShared, missing, clear, stats };
