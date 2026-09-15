// =============================================================================
// queryBuilder.js — Turn a resolved request into a provider query + cache key.
// =============================================================================
//
// This is the only place that knows how our taxonomy becomes words a search
// engine understands. The provider receives the finished string and knows
// nothing about sarees, pallus or lehengas.
//
const crypto = require('crypto');
const taxonomy = require('../taxonomy');
const { SOURCE_QUERY_TERMS } = require('./platforms');

/**
 * Extra terms appended to bias what kind of photograph comes back.
 *
 * These bias the search only. Nothing downstream inspects the returned images,
 * so this is a preference, not a filter.
 *
 * Measured by eye over 46 results (three searches, Sept 2026): `flatlay` still
 * returned a person wearing the garment 54% of the time - 18% for "red bridal
 * saree", 53% for "gold kanjivaram saree", 75% for "blue anarkali". Stitched
 * garments are the worst case; they are almost always shot on a model.
 *
 * An earlier comment here claimed 92% garment-only. That was wrong.
 */
const SHOT_TYPE_TERMS = {
  flatlay: ['flat', 'lay', 'product', 'photo'],
  worn: ['on', 'model'],
  any: []
};

/** Lowercased, trimmed, de-duplicated, order preserved. */
function normalizeTokens(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (const token of value.trim().toLowerCase().split(/\s+/)) {
      if (!token || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/**
 * @param {Object}   input                Already resolved and canonicalised.
 * @param {string[]} input.keywords
 * @param {string}   [input.category]     Canonical garment id, e.g. 'LEHANGA'.
 * @param {string}   [input.designType]   Design area id valid for that garment.
 * @param {Object}   [input.filters]      { color, fabric, occasion }
 * @param {string}   [input.shotType]     flatlay | worn | any
 * @param {string}   [input.source]       web | pinterest | instagram | facebook.
 *                                        `web` (the default) adds nothing, so an
 *                                        existing search is byte-identical.
 * @param {number}   input.page
 * @param {number}   input.limit
 * @returns {{ query: string, cacheKey: string }}
 */
function buildQuery({ keywords = [], category, designType, filters = {}, shotType = 'any', source = 'web', recency = 'any', page, limit }) {
  const garment = category ? taxonomy.getGarment(category) : null;
  const area = garment && designType ? taxonomy.getDesignType(garment.id, designType) : null;

  // The garment contributes its searchNoun, NOT its id: we search "lehenga" and
  // "kurti" even though the canonical ids are LEHANGA and KURTHI. Keeping the
  // three concerns apart - id, display name, search noun - is the whole point of
  // the taxonomy.
  const garmentTerm = garment ? garment.searchNoun : null;

  // "design" is appended ONLY for a component search. A broad garment search
  // stays byte-identical to what was validated live, so that evidence still
  // holds; "saree pallu" without it is a much weaker query than "saree pallu
  // design".
  const designWord = area ? 'design' : null;

  const tokens = normalizeTokens([
    ...keywords,
    filters.color,
    filters.fabric,
    garmentTerm,
    ...(area ? area.queryTerms : []),
    filters.occasion,
    designWord,
    ...(SHOT_TYPE_TERMS[shotType] || []),
    // Last, so the garment and design words keep their weight at the front.
    ...(SOURCE_QUERY_TERMS[source] || [])
  ]);

  const query = tokens.join(' ');

  // The cache key covers everything that changes the provider call. The finished
  // query already encodes category, designType, shotType, source and keywords.
  // `recency` is NOT part of the query text - it travels as a separate provider
  // parameter - so it must be in the key, or a "past week" search would be served
  // the cached "any time" answer. clientId is deliberately excluded: two clients
  // asking the same thing should share the cached answer rather than each
  // spending a credit.
  const cacheKey = crypto
    .createHash('sha1')
    .update(JSON.stringify(recency === 'any' ? { query, page, limit } : { query, page, limit, recency }))
    .digest('hex');

  return { query, cacheKey };
}

module.exports = { buildQuery, SHOT_TYPE_TERMS };
