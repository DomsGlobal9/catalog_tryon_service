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
 */
function buildFetchable(result, imageUsable) {
  if (imageUsable) {
    return { url: result.imageUrl, width: result.width, height: result.height, from: 'imageUrl' };
  }
  if (result.thumbnailUrl) {
    return {
      url: result.thumbnailUrl,
      width: result.thumbnailWidth ?? null,
      height: result.thumbnailHeight ?? null,
      from: 'thumbnailUrl'
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

    const imageUsable = hasUsableImageUrl(result);
    const fetchable = buildFetchable(result, imageUsable);
    if (!fetchable) continue; // no retrievable image at all - of no use to anyone

    seen.add(result.imageUrl);
    out.push({ ...result, imageUsable, fetchable });
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

module.exports = { search, filterResults, hasUsableImageUrl, buildFetchable };
