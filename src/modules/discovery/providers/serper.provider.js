// =============================================================================
// serper.provider.js — Serper.dev image search adapter.
// =============================================================================
//
// Serper wraps Google Images. One search costs one credit, which is why
// services/searchCache.js exists.
//
// Upstream response shape (fields we rely on):
//   { images: [ { title, imageUrl, imageWidth, imageHeight, thumbnailUrl,
//                 source, domain, link, position } ], credits: 1 }
//
const crypto = require('crypto');
const { config } = require('../discovery.config');
const { postJson } = require('../lib/httpClient');
const { NotConfiguredError } = require('../lib/errors');

/**
 * Deterministic id for a result. Derived from the image URL so the same design
 * carries the same id across repeated searches — useful for the caller's own
 * de-duplication, and it costs us no storage.
 */
function referenceId(imageUrl) {
  return 'result_' + crypto.createHash('sha1').update(imageUrl).digest('hex').slice(0, 12);
}

function domainOf(raw, fallbackUrl) {
  if (raw && typeof raw === 'string') return raw;
  try {
    return new URL(fallbackUrl).hostname;
  } catch {
    return null;
  }
}

function positiveInt(value) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

/**
 * Map one upstream item onto a DesignReference. Returns null for anything
 * unusable so the caller can simply filter.
 */
function normalize(item, index) {
  if (!item || typeof item.imageUrl !== 'string' || !item.imageUrl.startsWith('http')) return null;

  return {
    id: referenceId(item.imageUrl),
    position: positiveInt(item.position) || index + 1,
    title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : null,
    imageUrl: item.imageUrl,
    thumbnailUrl: typeof item.thumbnailUrl === 'string' ? item.thumbnailUrl : null,
    sourceUrl: typeof item.link === 'string' ? item.link : null,
    sourceDomain: domainOf(item.domain || item.source, item.link || item.imageUrl),
    width: positiveInt(item.imageWidth),
    height: positiveInt(item.imageHeight)
  };
}

/** @type {import('./imageSearchProvider').ImageSearchProvider} */
const serperProvider = {
  name: 'serper',

  async search({ query, page, limit }) {
    if (!config.isConfigured) throw new NotConfiguredError();

    const json = await postJson(config.serper.endpoint, {
      headers: { 'X-API-KEY': config.serper.apiKey },
      body: {
        q: query,
        num: limit,
        page,
        gl: config.serper.country,
        hl: config.serper.language
      },
      timeoutMs: config.serper.timeoutMs,
      providerName: 'Serper'
    });

    const images = Array.isArray(json && json.images) ? json.images : [];

    // rawCount is what the PROVIDER returned, counted before our own
    // normalization drops malformed entries. hasMore is derived from it, so
    // counting post-normalization would let a few broken items inside a full
    // page wrongly signal that there is nothing further to fetch.
    return { results: images.map(normalize).filter(Boolean), rawCount: images.length };
  }
};

module.exports = serperProvider;
