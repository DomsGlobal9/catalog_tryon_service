// =============================================================================
// discovery.controller.js — HTTP shaping for the discovery endpoints.
// =============================================================================
//
// No business logic here: shape has already been validated by middleware,
// meaning is resolved by searchInputResolver, the search itself belongs to
// designSearch.service. Errors are handed to discoveryErrorHandler.
//
const crypto = require('crypto');
const { config } = require('./discovery.config');
const taxonomy = require('./taxonomy');
const designSearchService = require('./services/designSearch.service');
const { resolveSearchInput } = require('./services/searchInputResolver');

/** POST /api/v1/discovery/search */
async function search(req, res, next) {
  // Correlation id only — there is no persistence layer, so this is for tracing
  // a request through the logs, NOT something the caller can fetch later.
  const searchId = crypto.randomUUID();
  const startedAt = Date.now();
  const clientId = (req.validated && req.validated.clientId) || 'unknown';

  try {
    // Throws ValidationError (400) for an unknown category, a design area that
    // does not belong to its garment, or an instruction nothing was found in.
    const resolved = resolveSearchInput(req.validated);

    const { query, results, rawCount, cached } = await designSearchService.search(resolved);

    console.log(
      `[Discovery] searchId=${searchId} client=${clientId} cached=${cached} ` +
      `cat=${resolved.category || '-'}/${resolved.designType || '-'} src=${resolved.interpreted.source} ` +
      `kept=${results.length}/${rawCount} ${Date.now() - startedAt}ms q="${query}"`
    );

    res.json({
      success: true,
      searchId,
      query,
      cached,
      interpreted: resolved.interpreted,
      results,
      pagination: {
        page: resolved.page,
        limit: resolved.limit,
        // Inferred, not authoritative: the provider reports no total count, so
        // a full page is the only signal that more may exist.
        hasMore: rawCount >= resolved.limit
      }
    });
  } catch (err) {
    console.warn(`[Discovery] searchId=${searchId} client=${clientId} failed: ${err.message}`);
    next(err);
  }
}

/** GET /api/v1/discovery/categories */
function categories(_req, res) {
  res.json({
    success: true,
    categories: taxonomy.GARMENT_IDS,
    shotTypes: ['flatlay', 'worn', 'any'],
    limits: { maxLimit: config.search.maxLimit, maxPage: config.search.maxPage }
  });
}

/**
 * GET /api/v1/discovery/taxonomy
 * The full garment -> design area tree, so the Manage Designs UI renders from
 * the service instead of hardcoding 107 entries.
 */
function taxonomyTree(_req, res) {
  res.json({
    success: true,
    garmentCount: taxonomy.integrity.garmentCount,
    designAreaCount: taxonomy.integrity.designAreaCount,
    garments: taxonomy.getTree()
  });
}

module.exports = { search, categories, taxonomy: taxonomyTree };
