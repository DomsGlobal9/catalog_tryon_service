// =============================================================================
// imageSearchProvider.js — The contract every search provider must satisfy.
// =============================================================================
//
// Serper is the only implementation today. This file exists so replacing it
// (Google CSE, Brave, a licensed catalogue) is a matter of writing one adapter
// and registering it — no service or controller code changes.
//

/**
 * A single design found on the web. This is the ONLY shape the rest of the
 * module — and our API contract — knows about. Provider-specific field names
 * never leak past the adapter.
 *
 * @typedef  {Object}      DesignReference
 * @property {string}      id            Stable within and across identical searches.
 * @property {number}      position      1-based rank as returned by the provider.
 * @property {string|null} title
 * @property {string}      imageUrl      Full-size image. Always present.
 * @property {string|null} thumbnailUrl
 * @property {string|null} sourceUrl     Page the image was found on.
 * @property {string|null} sourceDomain
 * @property {number|null} width
 * @property {number|null} height
 * @property {boolean}     [imageUsable]  Added by designSearch.service, not by
 *          providers. False when imageUrl serves an HTML page rather than an
 *          image (Instagram, Facebook) - the result is still returned, and its
 *          thumbnailUrl is a real image, but imageUrl must not be hotlinked.
 */

/**
 * @typedef  {Object} SearchParams
 * @property {string} query  Fully built provider query string.
 * @property {number} page   1-based.
 * @property {number} limit
 */

/**
 * @typedef  {Object} ProviderSearchResult
 * @property {DesignReference[]} results   Normalized, malformed entries removed.
 * @property {number}            rawCount  Items the provider returned, counted
 *                                         BEFORE normalization dropped any. The
 *                                         caller derives hasMore from this.
 *
 * @typedef  {Object}   ImageSearchProvider
 * @property {string}   name
 * @property {(params: SearchParams) => Promise<ProviderSearchResult>} search
 *
 * Implementations MUST throw only typed errors from lib/errors.js — in
 * particular ProviderError (424) for any upstream failure, never a raw network
 * error, so an outage cannot surface as a 5xx. See the policy note in errors.js.
 */

/** Throw early at boot if an adapter does not satisfy the contract. */
function assertValidProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('Search provider must be an object.');
  }
  if (typeof provider.name !== 'string' || !provider.name) {
    throw new Error('Search provider must expose a non-empty name.');
  }
  if (typeof provider.search !== 'function') {
    throw new Error(`Search provider "${provider.name}" must implement search().`);
  }
  return provider;
}

module.exports = { assertValidProvider };
