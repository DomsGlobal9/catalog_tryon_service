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

/**
 * Extra terms appended to bias what kind of photograph comes back.
 *
 * This matters more than it looks. A bare "red bridal saree" search returns
 * overwhelmingly on-model editorial shots; measured live, `flatlay` produced 92%
 * garment-only results against 10% for `any`. Callers who want product imagery
 * ask for it explicitly.
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
 * @param {number}   input.page
 * @param {number}   input.limit
 * @returns {{ query: string, cacheKey: string }}
 */
function buildQuery({ keywords = [], category, designType, filters = {}, shotType = 'any', page, limit }) {
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
    ...(SHOT_TYPE_TERMS[shotType] || [])
  ]);

  const query = tokens.join(' ');

  // The cache key covers everything that changes the provider call. The finished
  // query already encodes category, designType, shotType and keywords, so it
  // needs no separate fields. clientId is deliberately excluded: two clients
  // asking the same thing should share the cached answer rather than each
  // spending a credit.
  const cacheKey = crypto
    .createHash('sha1')
    .update(JSON.stringify({ query, page, limit }))
    .digest('hex');

  return { query, cacheKey };
}

module.exports = { buildQuery, SHOT_TYPE_TERMS };
