// =============================================================================
// capacity.js — how many generations THIS server runs at once.
// =============================================================================
//
// Deliberately per server, not shared: the limit protects this machine's memory
// (a women's generation holds four base poses and four ~740KB images at once; a
// men's one generates every requested size in parallel). With several servers,
// each takes its own share and the load balancer spreads the rest.
//
// Both pipelines draw from the same slots. Excess work is refused with 429, not
// queued, so a caller learns immediately instead of waiting on a request that
// would starve.
//
const MAX_CONCURRENT_GENERATIONS = Number(process.env.MAX_CONCURRENT_GENERATIONS || 3);
let active = 0;

/** @returns {(() => void) | null} a release function, or null when full. */
function tryAcquire() {
  if (active >= MAX_CONCURRENT_GENERATIONS) return null;
  active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
  };
}

function stats() {
  return { activeGenerations: active, maxConcurrent: MAX_CONCURRENT_GENERATIONS };
}

module.exports = { tryAcquire, stats, MAX_CONCURRENT_GENERATIONS };
