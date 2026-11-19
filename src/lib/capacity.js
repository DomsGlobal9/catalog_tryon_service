// =============================================================================
// capacity.js — how many generations THIS server runs at once, per product.
// =============================================================================
//
// Deliberately per server, not shared: the limit protects this machine's memory
// (a women's generation holds four base poses and four ~740KB images at once; a
// men's one generates every requested size in parallel). With several servers,
// each takes its own share and the load balancer spreads the rest.
//
// One pool per product (19 Nov 2026, owner: "new buckets for every service"). Before, every
// product drew from the same 3 slots, so three Design Studio requests of 1-3 minutes each
// left catalog customers with "service at capacity". Now:
//   catalog  women's + men's catalog   MAX_CONCURRENT_CATALOG (falls back to MAX_CONCURRENT_GENERATIONS, 3)
//   studio   Design Studio + sketch    MAX_CONCURRENT_STUDIO (2)
// Excess work is refused with 429, not queued, so a caller learns immediately
// instead of waiting on a request that would starve.
//
const int = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
const MAX_CONCURRENT_GENERATIONS = int(process.env.MAX_CONCURRENT_GENERATIONS, 3);
const LIMITS = {
  catalog: int(process.env.MAX_CONCURRENT_CATALOG, MAX_CONCURRENT_GENERATIONS),
  studio: int(process.env.MAX_CONCURRENT_STUDIO, 2)
};
const active = Object.fromEntries(Object.keys(LIMITS).map((k) => [k, 0]));

const poolOf = (pool) => (Object.prototype.hasOwnProperty.call(LIMITS, pool) ? pool : 'catalog');

/** @returns {(() => void) | null} a release function, or null when this product's pool is full. */
function tryAcquire(pool = 'catalog') {
  const p = poolOf(pool);
  if (active[p] >= LIMITS[p]) return null;
  active[p] += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active[p] -= 1;
  };
}

/** One product's pool (the catalog's by default, as before). */
function stats(pool = 'catalog') {
  const p = poolOf(pool);
  return { pool: p, activeGenerations: active[p], maxConcurrent: LIMITS[p] };
}

/** Every pool, for health and logs. */
function allStats() {
  return Object.fromEntries(Object.keys(LIMITS).map((p) => [p, { activeGenerations: active[p], maxConcurrent: LIMITS[p] }]));
}

module.exports = { tryAcquire, stats, allStats, LIMITS, MAX_CONCURRENT_GENERATIONS };
