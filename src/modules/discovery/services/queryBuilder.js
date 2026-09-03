// =============================================================================
// queryBuilder.js — Turn a structured request into a provider query + cache key.
// =============================================================================
const crypto = require('crypto');

/**
 * Extra terms appended to bias what kind of photograph comes back.
 *
 * This matters more than it looks. A bare "red bridal saree" search returns
 * overwhelmingly on-model editorial shots. Callers who intend to hand a result
 * to a garment-generation pipeline want the flat product photograph instead, so
 * they can ask for it explicitly.
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
 * @param {Object}   input
 * @param {string[]} input.keywords
 * @param {string}   [input.category]
 * @param {Object}   [input.filters]   { color, fabric, occasion }
 * @param {string}   [input.shotType]  flatlay | worn | any
 * @param {number}   input.page
 * @param {number}   input.limit
 * @returns {{ query: string, cacheKey: string }}
 */
function buildQuery({ keywords, category, filters = {}, shotType = 'any', page, limit }) {
  const tokens = normalizeTokens([
    ...keywords,
    filters.color,
    filters.fabric,
    category,
    filters.occasion,
    ...SHOT_TYPE_TERMS[shotType] || []
  ]);

  const query = tokens.join(' ');

  // The cache key covers everything that changes the provider call. clientId is
  // deliberately excluded: two clients asking the same thing should share the
  // cached answer rather than each spending a credit.
  const cacheKey = crypto
    .createHash('sha1')
    .update(JSON.stringify({ query, page, limit }))
    .digest('hex');

  return { query, cacheKey };
}

module.exports = { buildQuery, SHOT_TYPE_TERMS };
