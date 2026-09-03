// =============================================================================
// discovery.controller.js — HTTP shaping for the discovery endpoints.
// =============================================================================
//
// No business logic here: validate (already done by middleware), delegate to the
// service, shape the response. Errors are handed to discoveryErrorHandler.
//
const crypto = require('crypto');
const { CATEGORIES, config } = require('./discovery.config');
const designSearchService = require('./services/designSearch.service');

/** POST /api/v1/discovery/search */
async function search(req, res, next) {
  const input = req.validated;

  // Correlation id only — there is no persistence layer, so this is for tracing
  // a request through the logs, NOT something the caller can fetch later.
  const searchId = crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const { query, results, rawCount, cached } = await designSearchService.search(input);

    console.log(
      `[Discovery] searchId=${searchId} client=${input.clientId} cached=${cached} ` +
      `kept=${results.length}/${rawCount} ${Date.now() - startedAt}ms q="${query}"`
    );

    res.json({
      success: true,
      searchId,
      query,
      cached,
      results,
      pagination: {
        page: input.page,
        limit: input.limit,
        // Inferred, not authoritative: the provider reports no total count, so
        // a full page is the only signal that more may exist.
        hasMore: rawCount >= input.limit
      }
    });
  } catch (err) {
    console.warn(`[Discovery] searchId=${searchId} client=${input.clientId} failed: ${err.message}`);
    next(err);
  }
}

/** GET /api/v1/discovery/categories */
function categories(_req, res) {
  res.json({
    success: true,
    categories: CATEGORIES,
    shotTypes: ['flatlay', 'worn', 'any'],
    limits: { maxLimit: config.search.maxLimit, maxPage: config.search.maxPage }
  });
}

module.exports = { search, categories };
