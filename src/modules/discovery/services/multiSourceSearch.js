// =============================================================================
// multiSourceSearch.js — Search several sources in parallel.
// =============================================================================
//
// One resolved request fans out to one provider call per source (web, pinterest,
// instagram, facebook), all started at once. Both endpoints use this:
//
//   POST /search         waits for every source, then answers once in JSON
//   POST /search/stream  reports each source the moment it finishes, over SSE
//
// A failing source never takes the others down. It is reported alongside them,
// and only when EVERY source fails does the JSON endpoint turn that into an error.
//
const { buildQuery } = require('./queryBuilder');
const { fetchSource } = require('./designSearch.service');
const { applyResultFilters } = require('./resultFilters');
const { AppError } = require('../lib/errors');

/** The query each source will send, in the order the caller listed them. */
function planSources(resolved) {
  return resolved.sources.map((source) => {
    const { query, cacheKey } = buildQuery({ ...resolved, source });
    return { source, query, cacheKey };
  });
}

/**
 * Run one source to completion. Never throws: success and failure both come
 * back as an outcome, so Promise.all over sources cannot be cut short.
 */
async function runSource(plan, resolved) {
  const startedAt = Date.now();
  try {
    const { results, rawCount, cached } = await fetchSource({
      query: plan.query,
      cacheKey: plan.cacheKey,
      page: resolved.page,
      limit: resolved.limit
    });

    // A platform source keeps only that platform. Adding "pinterest" to a query
    // still returns some retailer images, and someone who asked for Pinterest
    // should not have to pick them out. A web search keeps everything - including
    // Pinterest or Instagram results it happens to find.
    const onPlatform = plan.source === 'web' ? results : results.filter((r) => r.platform === plan.source);
    const { kept, removed, removedBy } = applyResultFilters(onPlatform, resolved.resultFilters);

    return {
      source: plan.source,
      query: plan.query,
      status: 'ok',
      cached,
      results: kept.map((r) => ({ ...r, foundBy: plan.source })),
      offPlatform: results.length - onPlatform.length,
      removedByFilters: removed,
      removedBy,
      hasMore: rawCount >= resolved.limit,
      durationMs: Date.now() - startedAt
    };
  } catch (err) {
    const expected = err instanceof AppError;
    if (!expected) {
      // A genuine bug, not an outage. Logged in full; reported to the caller
      // without internals.
      console.error(`[Discovery] source=${plan.source} unexpected error:`, err && err.stack ? err.stack : err);
    }
    return {
      source: plan.source,
      query: plan.query,
      status: 'error',
      cached: false,
      results: [],
      error: {
        code: expected ? err.code : 'INTERNAL_ERROR',
        message: expected ? err.message : 'Unexpected error while searching this source.'
      },
      durationMs: Date.now() - startedAt,
      _err: err
    };
  }
}

/**
 * @param {Object}   resolved            Output of searchInputResolver.
 * @param {Object}   [hooks]
 * @param {Function} [hooks.onPlan]      (plans) - before any provider call.
 * @param {Function} [hooks.onOutcome]   (outcome) - as each source finishes.
 * @returns {Promise<{ plans: Object[], outcomes: Object[] }>}  outcomes in plan order.
 */
async function searchSources(resolved, hooks = {}) {
  const plans = planSources(resolved);
  if (hooks.onPlan) hooks.onPlan(plans);

  const outcomes = await Promise.all(
    plans.map(async (plan) => {
      const outcome = await runSource(plan, resolved);
      if (hooks.onOutcome) hooks.onOutcome(outcome);
      return outcome;
    })
  );

  return { plans, outcomes };
}

/**
 * Remove results already seen, by image. The first occurrence wins. Mutates
 * `seen` so it can be shared across calls - the stream uses one set for the
 * whole response, arriving source by source.
 */
function dedupe(results, seen) {
  const fresh = [];
  for (const r of results) {
    const key = r.id || r.imageUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(r);
  }
  return fresh;
}

/** Per-source summary without results or internals - safe to send. */
function summarise(outcome, returned) {
  const s = {
    source: outcome.source,
    query: outcome.query,
    status: outcome.status,
    cached: outcome.cached,
    durationMs: outcome.durationMs
  };
  if (outcome.status === 'ok') {
    s.returned = returned;
    s.duplicates = outcome.results.length - returned;
    s.removedByFilters = outcome.removedByFilters;
    s.offPlatform = outcome.offPlatform;
    s.hasMore = outcome.hasMore;
  } else {
    s.error = outcome.error;
  }
  return s;
}

module.exports = { searchSources, planSources, dedupe, summarise };
