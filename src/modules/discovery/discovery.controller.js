// =============================================================================
// discovery.controller.js — HTTP shaping for the discovery endpoints.
// =============================================================================
//
// No business logic here: shape has already been validated by middleware,
// meaning is resolved by searchInputResolver, and the search itself belongs to
// multiSourceSearch. Errors raised BEFORE a response starts are handed to
// discoveryErrorHandler, so they keep their normal 4xx status - including on the
// streaming endpoint, which only opens its stream once the request is known good.
//
const crypto = require('crypto');
const { config } = require('./discovery.config');
const taxonomy = require('./taxonomy');
const { resolveSearchInput } = require('./services/searchInputResolver');
const { searchSources, planSources, dedupe, summarise } = require('./services/multiSourceSearch');
const { SOURCES } = require('./services/platforms');
const cache = require('./services/searchCache');
const rateLimit = require('./middleware/rateLimit');
const { ORIENTATIONS, SHOT_TYPES, RECENCIES } = require('./middleware/validate');
const { NotConfiguredError } = require('./lib/errors');

/**
 * Build the per-source plans and charge the client for the provider calls they
 * will really make - sources already in the cache are free. Throws RateLimitError.
 */
function planAndCharge(resolved, clientId) {
  const plans = planSources(resolved);
  const uncached = plans.filter((p) => !cache.has(p.cacheKey)).length;
  const refused = rateLimit.charge(clientId, uncached);
  if (refused) throw refused;
  return plans;
}

function logLine(searchId, clientId, resolved, sources, startedAt, extra = '') {
  const perSource = sources
    .map((s) => (s.status === 'ok' ? `${s.source}:${s.returned}${s.cached ? '(cache)' : ''}` : `${s.source}:ERR`))
    .join(' ');
  console.log(
    `[Discovery] searchId=${searchId} client=${clientId} ` +
    `cat=${resolved.category || '-'}/${resolved.designType || '-'} src=${resolved.interpreted.source} ` +
    `[${perSource}] ${Date.now() - startedAt}ms${extra}`
  );
}

/**
 * POST /api/v1/discovery/search
 *
 * Waits for every source, then answers once. With the default `sources: ['web']`
 * the response is the same shape it has always been, plus additive fields.
 */
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
    const plans = planAndCharge(resolved, clientId);
    const { outcomes } = await searchSources(resolved, { plans });

    const succeeded = outcomes.filter((o) => o.status === 'ok');
    if (!succeeded.length) {
      // Every source failed. Surface the first failure exactly as a single search
      // always has - a provider outage stays 424, a genuine bug stays 500.
      throw outcomes[0]._err;
    }

    // Merge in the order the caller listed the sources, so the same request
    // always produces the same order regardless of which source answered first.
    const seen = new Set();
    const results = [];
    const sources = [];
    for (const outcome of outcomes) {
      const fresh = outcome.status === 'ok' ? dedupe(outcome.results, seen) : [];
      results.push(...fresh);
      sources.push(summarise(outcome, fresh.length));
    }

    logLine(searchId, clientId, resolved, sources, startedAt);

    res.json({
      success: true,
      searchId,
      query: outcomes[0].query,
      cached: succeeded.every((o) => o.cached),
      interpreted: resolved.interpreted,
      results,
      sources,
      pagination: {
        page: resolved.page,
        limit: resolved.limit,
        // Inferred, not authoritative: the provider reports no total count, so a
        // full page from any source is the only signal that more may exist.
        hasMore: succeeded.some((o) => o.hasMore)
      }
    });
  } catch (err) {
    console.warn(`[Discovery] searchId=${searchId} client=${clientId} failed: ${err && err.message}`);
    next(err);
  }
}

/**
 * POST /api/v1/discovery/search/stream
 *
 * The same search, reported as Server-Sent Events. Every source starts at once
 * and each one's results are sent the moment that source finishes, so a caller
 * sees the fast sources while the slow ones are still working.
 *
 * Event order:  start  ->  source (one per source, in finishing order)  ->  done
 *
 * Anything wrong with the request is rejected BEFORE the stream opens, as a
 * normal JSON 4xx. Once the stream is open the status is already 200, so a source
 * that fails is reported inside its `source` event instead.
 */
async function searchStream(req, res, next) {
  const searchId = crypto.randomUUID();
  const startedAt = Date.now();
  const clientId = (req.validated && req.validated.clientId) || 'unknown';

  let resolved;
  let plans;
  try {
    resolved = resolveSearchInput(req.validated);
    // Checked here rather than per source: a switched-off deployment should answer
    // 424 like the JSON endpoint, not open a stream of four identical failures.
    if (!config.isConfigured) throw new NotConfiguredError();
    // Charged before the stream opens, so running out of budget is a normal 429.
    plans = planAndCharge(resolved, clientId);
  } catch (err) {
    return next(err);
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Tells nginx-style proxies not to hold the stream back in a buffer.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closedByClient = false;
  let finished = false;
  const write = (chunk) => {
    if (closedByClient || res.writableEnded || res.destroyed) return;
    try {
      res.write(chunk);
    } catch {
      closedByClient = true;
    }
  };
  const send = (event) => write(`data: ${JSON.stringify(event)}\n\n`);

  const heartbeat = setInterval(() => write(`: keepalive ${Date.now()}\n\n`), config.stream.heartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

  // 'close' also fires after a normal end, so only a close before we finished
  // counts as the caller walking away. The provider calls already in flight are
  // left to complete: they are paid for the moment they are sent, and letting them
  // finish means their results land in the cache for the next request.
  res.on('close', () => {
    clearInterval(heartbeat);
    if (!finished) closedByClient = true;
  });

  const seen = new Set();
  const summaries = new Map();
  let total = 0;

  try {
    const { outcomes } = await searchSources(resolved, {
      plans,
      onPlan: (planned) =>
        send({
          type: 'start',
          searchId,
          interpreted: resolved.interpreted,
          page: resolved.page,
          limit: resolved.limit,
          sources: planned.map((p) => ({ source: p.source, query: p.query }))
        }),
      onOutcome: (outcome) => {
        const fresh = outcome.status === 'ok' ? dedupe(outcome.results, seen) : [];
        total += fresh.length;
        const summary = summarise(outcome, fresh.length);
        summaries.set(outcome.source, summary);
        send(outcome.status === 'ok' ? { type: 'source', ...summary, results: fresh } : { type: 'source', ...summary });
      }
    });

    const ordered = plans.map((p) => summaries.get(p.source));
    const succeeded = outcomes.filter((o) => o.status === 'ok');
    const status = succeeded.length === outcomes.length ? 'ok' : succeeded.length ? 'partial' : 'failed';

    send({
      type: 'done',
      searchId,
      status,
      total,
      cached: succeeded.length > 0 && succeeded.every((o) => o.cached),
      hasMore: succeeded.some((o) => o.hasMore),
      sources: ordered,
      durationMs: Date.now() - startedAt
    });

    logLine(searchId, clientId, resolved, ordered, startedAt,
      ` stream status=${status}${closedByClient ? ' (client left early)' : ''}`);
  } catch (err) {
    // searchSources never rejects for a source failure, so reaching here is a bug.
    console.error(`[Discovery] searchId=${searchId} stream crashed:`, err && err.stack ? err.stack : err);
    send({ type: 'error', searchId, code: 'INTERNAL_ERROR', message: 'The search failed unexpectedly.' });
  } finally {
    finished = true;
    clearInterval(heartbeat);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

/** GET /api/v1/discovery/categories */
function categories(_req, res) {
  res.json({
    success: true,
    categories: taxonomy.GARMENT_IDS,
    shotTypes: SHOT_TYPES,
    recency: RECENCIES,
    sources: SOURCES,
    resultFilters: {
      fullSizeOnly: 'boolean',
      minWidth: 'integer',
      orientation: ORIENTATIONS,
      excludeDomains: 'string[] (max 20)'
    },
    limits: {
      maxLimit: config.search.maxLimit,
      maxPage: config.search.maxPage,
      maxSources: config.search.maxSources
    }
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

module.exports = { search, searchStream, categories, taxonomy: taxonomyTree };
