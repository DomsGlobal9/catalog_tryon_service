// =============================================================================
// discovery.config.js — Environment and tuning for the design discovery module.
// =============================================================================
//
// Read once at require-time. Nothing else in the module touches process.env.
//
const { registerSecret } = require('./lib/redact');

function intFromEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    console.warn(`[Discovery] ${name}="${raw}" is not a number. Falling back to ${fallback}.`);
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

const serperApiKey = (process.env.SERPER_API_KEY || '').trim();

// So the key can never appear in a log line or an error response.
registerSecret(serperApiKey);

const config = {
  providerName: 'serper',

  serper: {
    apiKey: serperApiKey,
    endpoint: 'https://google.serper.dev/images',
    // Google country/language bias. 'in' returns materially better results for
    // Indian ethnic wear, which is the catalogue this platform serves.
    country: (process.env.SERPER_COUNTRY || 'in').trim(),
    language: (process.env.SERPER_LANGUAGE || 'en').trim(),
    timeoutMs: intFromEnv('SERPER_TIMEOUT_MS', 8000, 1000, 30000)
  },

  cache: {
    ttlSec: intFromEnv('DISCOVERY_CACHE_TTL_SEC', 3600, 0, 86400),
    maxEntries: intFromEnv('DISCOVERY_CACHE_MAX_ENTRIES', 500, 1, 10000)
  },

  rateLimit: {
    perMinute: intFromEnv('DISCOVERY_RATE_LIMIT_PER_MIN', 20, 1, 10000)
  },

  search: {
    defaultLimit: 20,
    maxLimit: 50,
    maxPage: 20,
    maxKeywords: 12,
    // Anything smaller than this is a sprite, icon or tracking pixel, not a design.
    minImageWidth: 400,
    minImageHeight: 400,

    // Hosts that serve an HTML page rather than an image at the URL the provider
    // reports as imageUrl, making the result unusable to any consumer.
    //
    // Chosen from measurement, not from a notion of which sites are "social":
    // across 119 live results over 6 queries, instagram was 0/4 usable and
    // facebook 0/1, while every other host was 100%. Pinterest is deliberately
    // ABSENT - it scored 4/4, serving real image/jpeg and image/png from its
    // CDN, and is a genuinely useful design source.
    //
    // Matched against BOTH the imageUrl's host and sourceDomain. Neither alone
    // is sufficient: facebook serves its images from lookaside.fbsbx.com (so the
    // image host misses it), while pinterest serves from i.pinimg.com and must
    // be kept (so blocking purely by source domain would be too blunt if it were
    // ever listed).
    blockedImageHosts: (process.env.DISCOVERY_BLOCKED_IMAGE_HOSTS || 'instagram.com,facebook.com')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  },

  // The service-wide express.json limit is 50mb because generation accepts
  // base64 images. A keyword search has no business with that ceiling.
  bodyLimit: '32kb',

  /** False means discovery is deployed but switched off; endpoints return 424. */
  isConfigured: serperApiKey.length > 0
};

/**
 * The garment vocabulary this platform understands.
 *
 * Deliberately a hardcoded copy of the keys in src/config/sys-constants.js
 * rather than an import: the discovery module must not depend on the generation
 * module, so it can be lifted into its own service without untangling anything.
 */
const CATEGORIES = ['SAREE', 'LEHANGA', 'ANARKALI', 'SHARARA', 'KURTHI'];

/**
 * serper.dev and serpapi.com are different companies with similar names, and a
 * serpapi.com key pasted here fails only at request time as an opaque 403 ->
 * 424. Observed shapes: serper.dev keys are 40 hex chars, serpapi.com keys are
 * 64. Warn at boot rather than letting the operator debug it per-request.
 */
function looksLikeSerpApiComKey(key) {
  return /^[0-9a-f]{64}$/.test(key);
}

/** Called once from src/index.js so the operator sees the state at boot. */
function logBootStatus() {
  if (config.isConfigured) {
    console.log(`   - Design Discovery: ENABLED (provider: ${config.providerName}, gl=${config.serper.country})`);
    if (looksLikeSerpApiComKey(config.serper.apiKey)) {
      console.warn('     WARNING: SERPER_API_KEY looks like a serpapi.com key (64 hex chars).');
      console.warn('     This service talks to serper.dev, which will reject it with 403.');
      console.warn('     Get a serper.dev key at https://serper.dev/api-key');
    }
  } else {
    console.warn('   - Design Discovery: DISABLED — SERPER_API_KEY is not set.');
    console.warn('     /api/v1/discovery/* will return 424. Catalog generation is unaffected.');
  }
}

module.exports = { config, CATEGORIES, logBootStatus, looksLikeSerpApiComKey };
