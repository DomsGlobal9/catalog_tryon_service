// =============================================================================
// designSearch.service.js — One provider search, filtered and cached.
// =============================================================================
//
//   query -> cache lookup -> (shared) provider call -> filter -> cache store
//
// Searching several sources at once lives in multiSourceSearch.js, which calls
// fetchSource() here once per source.
//
// Nothing here downloads, stores or transforms an image. The service returns
// *references* to designs found on the web; what the caller does with them is
// their responsibility.
//
const { config } = require('../discovery.config');
const { getProvider } = require('../providers');
const { buildQuery } = require('./queryBuilder');
const { platformOf, upgradePinterestImage } = require('./platforms');
const cache = require('./searchCache');
const { createLimiter } = require('../lib/limiter');

/** Every provider call in this process goes through one queue. See lib/limiter.js. */
const providerLimiter = createLimiter(config.provider.concurrency, { maxWaitMs: config.provider.queueTimeoutMs });

function matchesNonImageHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  return config.search.nonImageHosts.some(
    (blocked) => h === blocked || h.endsWith('.' + blocked)
  );
}

/**
 * Whether `imageUrl` can actually be loaded as an image.
 *
 * Instagram and Facebook report an imageUrl that serves an HTML page, so a
 * consumer must not hotlink it - but their thumbnailUrl IS a real image, which
 * is why those results are still worth returning. Callers branch on this flag
 * rather than on the domain.
 *
 * Checks the imageUrl's host AND the sourceDomain, because neither alone is
 * enough: facebook results carry sourceDomain facebook.com but an imageUrl on
 * lookaside.fbsbx.com. Suffix matching covers subdomains.
 */
function hasUsableImageUrl(result) {
  let host = null;
  try {
    host = new URL(result.imageUrl).hostname;
  } catch {
    host = null;
  }
  return !(matchesNonImageHost(host) || matchesNonImageHost(result.sourceDomain));
}

/**
 * The URL a consumer should actually retrieve, plus the true dimensions of that
 * asset. This is the field a caller should read instead of branching on
 * `imageUsable` and picking a URL themselves.
 *
 * `width`/`height` on the result describe imageUrl - the original asset the
 * source claims, whether or not it can be fetched. That is legitimate
 * provenance and is deliberately left alone. Truth about *retrievability* lives
 * here, and for Instagram/Facebook the two differ by roughly 3x: a post
 * reported as 1440x1920 yields only a ~387x516 thumbnail.
 *
 * NOT a promise of permanent availability. CDN URLs, signed URLs and social
 * thumbnails expire and rotate. This is the asset that satisfied our
 * image-capability checks at search time.
 *
 * `sizeExact` says whether width/height describe THIS url as reported, or are our
 * estimate. It is false only for an upgraded Pinterest image, whose larger file
 * we deliberately do not download to measure - see platforms.js. Those also
 * carry `fallbackUrl`, the original smaller image, in case the larger one fails.
 */
function buildFetchable(result, imageUsable) {
  if (imageUsable) {
    const upgraded = upgradePinterestImage(result);
    if (upgraded) {
      return {
        url: upgraded.url,
        width: upgraded.width,
        height: upgraded.height,
        from: 'imageUrl',
        sizeExact: false,
        fallbackUrl: result.imageUrl
      };
    }
    return { url: result.imageUrl, width: result.width, height: result.height, from: 'imageUrl', sizeExact: true };
  }
  if (result.thumbnailUrl) {
    return {
      url: result.thumbnailUrl,
      width: result.thumbnailWidth ?? null,
      height: result.thumbnailHeight ?? null,
      from: 'thumbnailUrl',
      sizeExact: true
    };
  }
  return null; // caller drops these - nothing viewable at all
}

/**
 * Drop results that are unusable, and de-duplicate by image URL.
 *
 * Note the deliberate asymmetry on dimensions: a result is only rejected when
 * the provider reported a size AND that size is too small. Missing dimensions
 * are common and are not grounds for discarding an otherwise good design.
 *
 * We do NOT probe each imageUrl to confirm it is really an image. Measurement
 * showed the host is an exact proxy (no host was partially bad), so a free
 * string check buys the same correctness as 20 extra network round trips.
 *
 * Results whose imageUrl is not a real image are annotated rather than removed,
 * so Instagram and Facebook designs still reach the caller. The only such
 * result dropped is one that also has no thumbnail - it carries no viewable
 * image at all and is of no use to anyone.
 *
 * The size check normally reads the ORIGINAL width/height. The exception is an
 * upgraded Pinterest image: its original is a 236px preview of a larger file, so
 * judging it by 236 threw away most Pinterest results. It is judged by the size
 * of the file we actually hand out instead.
 */
function filterResults(results) {
  const { minImageWidth, minImageHeight } = config.search;
  const seen = new Set();
  const out = [];

  for (const result of results) {
    if (!result || !result.imageUrl) continue;
    if (seen.has(result.imageUrl)) continue;

    const imageUsable = hasUsableImageUrl(result);
    const fetchable = buildFetchable(result, imageUsable);
    if (!fetchable) continue; // no retrievable image at all - of no use to anyone

    const judged = fetchable.sizeExact === false ? fetchable : result;
    if (judged.width !== null && judged.width < minImageWidth) continue;
    if (judged.height !== null && judged.height < minImageHeight) continue;

    seen.add(result.imageUrl);
    out.push({ ...result, platform: platformOf(result), imageUsable, fetchable });
  }

  return out;
}

/**
 * Provider calls currently in flight, keyed like the cache.
 *
 * Without this, two identical searches arriving together both miss the cache and
 * both pay for a provider call. With it, the second waits for the first and they
 * share one call - and one bill. A failed call is shared too, but never cached,
 * so the next request after it tries again.
 */
const inflight = new Map();

/**
 * One provider search for one already-built query.
 *
 * rawCount is the number of results the provider returned BEFORE filtering.
 * `hasMore` is derived from it rather than from results.length, otherwise a page
 * that happened to contain several undersized images would wrongly report that
 * there is nothing further to fetch.
 *
 * @returns {Promise<{ results: Object[], rawCount: number, cached: boolean }>}
 */
async function fetchSource({ query, cacheKey, page, limit, recency = 'any' }) {
  const hit = cache.get(cacheKey);
  if (hit) return { results: hit.results, rawCount: hit.rawCount, cached: true };

  if (!inflight.has(cacheKey)) {
    const call = (async () => {
      // Another server may already have paid for this exact search.
      const shared = await cache.getShared(cacheKey);
      if (shared) return { value: shared, cached: true };

      const { results: providerResults, rawCount } = await providerLimiter.run(
        () => getProvider().search({ query, page, limit, recency })
      );
      const value = { results: filterResults(providerResults), rawCount };
      cache.set(cacheKey, value);
      return { value, cached: false };
    })();
    inflight.set(cacheKey, call);
    // Clear the slot however the call ends. `catch` stops this bookkeeping promise
    // from being reported as unhandled; the real error still reaches the awaiters.
    call.finally(() => inflight.delete(cacheKey)).catch(() => {});
  }

  const { value, cached } = await inflight.get(cacheKey);
  return { results: value.results, rawCount: value.rawCount, cached };
}

/**
 * Single web search - the original entry point, kept so existing callers and
 * tests are unaffected.
 *
 * @param   {Object}   input  Resolved search input.
 * @returns {Promise<{ query: string, results: Object[], rawCount: number, cached: boolean }>}
 */
async function search(input) {
  const { page, limit, recency } = input;
  const { query, cacheKey } = buildQuery(input);
  const out = await fetchSource({ query, cacheKey, page, limit, recency });
  return { query, ...out };
}

module.exports = {
  search, fetchSource, filterResults, hasUsableImageUrl, buildFetchable,
  _inflight: inflight, _providerLimiter: providerLimiter
};
