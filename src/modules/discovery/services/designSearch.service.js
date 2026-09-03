// =============================================================================
// designSearch.service.js — Orchestrates a design search.
// =============================================================================
//
//   build query -> cache lookup -> provider call -> filter -> cache store
//
// Nothing here downloads, stores or transforms an image. The service returns
// *references* to designs found on the web; what the caller does with them is
// their responsibility.
//
const { config } = require('../discovery.config');
const { getProvider } = require('../providers');
const { buildQuery } = require('./queryBuilder');
const cache = require('./searchCache');

/**
 * Drop results that are unusable, and de-duplicate by image URL.
 *
 * Note the deliberate asymmetry on dimensions: a result is only rejected when
 * the provider reported a size AND that size is too small. Missing dimensions
 * are common and are not grounds for discarding an otherwise good design.
 */
function filterResults(results) {
  const { minImageWidth, minImageHeight } = config.search;
  const seen = new Set();
  const out = [];

  for (const result of results) {
    if (!result || !result.imageUrl) continue;
    if (seen.has(result.imageUrl)) continue;
    if (result.width !== null && result.width < minImageWidth) continue;
    if (result.height !== null && result.height < minImageHeight) continue;

    seen.add(result.imageUrl);
    out.push(result);
  }

  return out;
}

/**
 * rawCount is the number of results the provider returned BEFORE filtering.
 * The controller derives `hasMore` from it rather than from results.length,
 * otherwise a page that happened to contain several undersized images would
 * wrongly report that there is nothing further to fetch.
 *
 * @param   {Object}   input  Already validated by middleware/validate.js.
 * @returns {Promise<{ query: string, results: Object[], rawCount: number, cached: boolean }>}
 */
async function search(input) {
  const { page, limit } = input;
  const { query, cacheKey } = buildQuery(input);

  const hit = cache.get(cacheKey);
  if (hit) {
    return { query, results: hit.results, rawCount: hit.rawCount, cached: true };
  }

  const provider = getProvider();
  const { results: providerResults, rawCount } = await provider.search({ query, page, limit });
  const results = filterResults(providerResults);

  cache.set(cacheKey, { results, rawCount });

  return { query, results, rawCount, cached: false };
}

module.exports = { search, filterResults };
