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
    // Was 8000. Measured provider response times over 8 recent calls included
    // 9.0s and 10.5s - both would have failed as 424 at the old ceiling, and a
    // search across four sources makes four such calls. 15s leaves headroom and
    // still sits far inside the gateway's 90s limit.
    timeoutMs: intFromEnv('SERPER_TIMEOUT_MS', 15000, 1000, 30000)
  },

  stream: {
    // SSE comment sent while waiting on slow sources, so no proxy between the
    // caller and us closes an idle connection.
    heartbeatMs: intFromEnv('DISCOVERY_STREAM_HEARTBEAT_MS', 10000, 1000, 60000)
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
    // The upstream provider returns up to 100 images in a single call, and
    // charges the SAME 2 credits whether asked for 20, 50 or 100 (measured
    // directly against the provider). So a caller who wants 100 designs should
    // ask once rather than page five times - identical result, one fifth the
    // credits and one fifth the latency. 100 is the provider ceiling, not ours.
    maxLimit: 100,
    maxPage: 20,
    maxKeywords: 12,
    // A floor for genuine junk only - sprites, icons, tracking pixels.
    //
    // This was 400, and 400 was throwing away real designs. Measured over 500
    // results from five searches: 20 were under 400px, NONE were under 150px, and
    // every one of the 20 was a real garment photo (236-385px) - retailer
    // listings, blog images, and above all Pinterest previews. So the floor now
    // only removes what is actually junk, and a caller who wants large images
    // asks for them with `resultFilters.minWidth`, which is guaranteed.
    minImageWidth: 150,
    minImageHeight: 150,
    // Most sources a single search may fan out to - one provider call each.
    maxSources: 4,

    // Hosts that serve an HTML page rather than an image at the URL the provider
    // reports as imageUrl. These results are NOT dropped - they are returned
    // with `imageUsable: false` so a caller knows to render thumbnailUrl and
    // link to sourceUrl instead of hotlinking imageUrl.
    //
    // Chosen from measurement, not from a notion of which sites are "social".
    // Instagram serves imageUrl from lookaside.instagram.com and facebook from
    // lookaside.fbsbx.com, both text/html, 0/10 usable each - but their
    // thumbnailUrl is a real image 10/10 of the time, which is why the results
    // are worth returning at all. Pinterest is deliberately ABSENT: it serves
    // real images from i.pinimg.com, 10/10, and needs no flag.
    //
    // Matched against BOTH the imageUrl's host and sourceDomain, because neither
    // alone is sufficient - facebook's image host does not contain "facebook.com".
    nonImageHosts: (process.env.DISCOVERY_NON_IMAGE_HOSTS || 'instagram.com,facebook.com')
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
  // Required here rather than at module top: discovery.config is loaded very
  // early and the taxonomy is only needed once we report status.
  const taxonomy = require('./taxonomy');

  // A taxonomy defect disables discovery but must never stop the process -
  // generate-catalog has nothing to do with it. Same fail-soft convention as a
  // missing SERPER_API_KEY. The hard gate for this is the test suite.
  if (!taxonomy.integrity.ok) {
    console.error('   - Design Discovery: DISABLED — taxonomy integrity check FAILED.');
    for (const err of taxonomy.integrity.errors) console.error('       * ' + err);
    console.error('     /api/v1/discovery/* will return 424. Catalog generation is unaffected.');
    return;
  }

  if (config.isConfigured) {
    console.log(`   - Design Discovery: ENABLED (provider: ${config.providerName}, gl=${config.serper.country}, ` +
                `${taxonomy.integrity.garmentCount} garments / ${taxonomy.integrity.designAreaCount} design areas)`);
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

module.exports = { config, logBootStatus, looksLikeSerpApiComKey };
