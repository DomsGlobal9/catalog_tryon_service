// =============================================================================
// config.js — every Design Studio setting in one place.
// =============================================================================
//
// All optional. Read once at load; tests set process.env before requiring.
//
const int = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const list = (name, fallback) =>
  (process.env[name] ? process.env[name].split(',') : fallback).map((s) => s.trim().toLowerCase()).filter(Boolean);

const config = {
  gemini: {
    // Nano Banana 2 - the current Flash image model, already used by try-on.
    model: process.env.DESIGNSTUDIO_MODEL || 'gemini-3.1-flash-image',
    baseUrl: (process.env.DESIGNSTUDIO_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
    apiKey: () => process.env.GEMINI_API_KEY || '',
    // 1K | 2K | 4K. 2K is the catalogue sweet spot: fabric weave and zari stay
    // crisp, and the image is still a sensible size to send back as base64.
    imageSize: (process.env.DESIGNSTUDIO_IMAGE_SIZE || '2K').toUpperCase(),
    // Fixed by product decision: portrait catalogue photographs.
    aspectRatio: '3:4',
    // Unset by default: Google's own default (1.0) is recommended for Gemini 3
    // models; forcing it low can degrade them. Set to override.
    temperature: process.env.DESIGNSTUDIO_TEMPERATURE === undefined ? null : Number(process.env.DESIGNSTUDIO_TEMPERATURE),
    // Measured: real generations took 25-61s, but one attempt hung past 120s.
    // A slow attempt gets cut off and tried once more; the caller is already on an
    // open stream with keep-alives, so a longer total is safe.
    attemptTimeoutMs: int('DESIGNSTUDIO_ATTEMPT_TIMEOUT_MS', 100000, { min: 1000 }),
    // Hard ceiling for the whole generation including retries.
    deadlineMs: int('DESIGNSTUDIO_DEADLINE_MS', 220000, { min: 1000 }),
    // Extra tries after an attempt that never answered in time.
    timeoutRetries: int('DESIGNSTUDIO_TIMEOUT_RETRIES', 1, { max: 2 }),
    // Extra tries after a busy/unavailable answer (429, 5xx, dropped connection).
    retries: int('DESIGNSTUDIO_RETRIES', 2, { max: 5 }),
    // Extra tries when the model answers but returns no image.
    noImageRetries: int('DESIGNSTUDIO_NO_IMAGE_RETRIES', 1, { max: 3 }),
    retryBaseMs: int('DESIGNSTUDIO_RETRY_BASE_MS', 2000)
  },

  // Step one of two: a cheap text model looks at each reference and writes a
  // precise description of it (motifs, repeat, colours, technique, weave), which
  // is then given to the image model alongside the pictures. Measured: images
  // alone lost temple motifs and small-motif colours. Never required - if this
  // call fails or times out, generation continues with the images only.
  describe: {
    enabled: String(process.env.DESIGNSTUDIO_DESCRIBE || 'on').toLowerCase() !== 'off',
    model: process.env.DESIGNSTUDIO_DESCRIBE_MODEL || 'gemini-2.5-flash',
    // Per ATTEMPT. Measured: 8-10s normally, but two real runs hit 25s on one
    // attempt and, with a single shared limit, the retry never ran. Each attempt
    // now has its own limit inside an overall deadline.
    timeoutMs: int('DESIGNSTUDIO_DESCRIBE_TIMEOUT_MS', 25000, { min: 100 }),
    deadlineMs: int('DESIGNSTUDIO_DESCRIBE_DEADLINE_MS', 55000, { min: 200 }),
    // gemini-2.5-flash is a thinking model and its thinking counts against this
    // cap. Measured: ~550 thinking + ~360-540 answer tokens for four references,
    // so 2048 left too little room on an unlucky run. Thinking is capped
    // separately so it can never eat the answer.
    maxOutputTokens: int('DESIGNSTUDIO_DESCRIBE_MAX_TOKENS', 8192, { min: 256 }),
    // Measured: an ajrakh block print was read as "woven brocade" in about half of
    // runs at 1024 thinking tokens, and "printed" 5 of 5 at 4096, while woven and
    // embroidered references stayed correct. Costs roughly 5s more per request.
    thinkingBudget: int('DESIGNSTUDIO_DESCRIBE_THINKING_BUDGET', 4096, { min: 0, max: 8192 })
  },

  limits: {
    maxDesigns: int('DESIGNSTUDIO_MAX_DESIGNS', 6, { min: 1, max: 10 }),
    maxFabrics: int('DESIGNSTUDIO_MAX_FABRICS', 3, { min: 0, max: 5 }),
    maxBodyMb: int('DESIGNSTUDIO_MAX_BODY_MB', 50, { min: 1, max: 200 }), // the gateway refuses bodies over 50 MB
    maxImageBytes: int('DESIGNSTUDIO_MAX_IMAGE_MB', 12, { min: 1, max: 50 }) * 1024 * 1024,
    maxNoteChars: 300,
    maxNotesChars: 600
  },

  input: {
    // Only these hosts are ever downloaded from. Cloudinary serves customer
    // uploads from res.cloudinary.com (and numbered res-N shards).
    allowedHosts: list('DESIGNSTUDIO_ALLOWED_IMAGE_HOSTS', ['res.cloudinary.com']),
    downloadTimeoutMs: int('DESIGNSTUDIO_DOWNLOAD_TIMEOUT_MS', 15000, { min: 500 }),
    maxRedirects: 3,
    // Longest edge sent to the model. Motif detail survives at 1536; beyond that
    // the request grows without the model seeing more.
    maxEdgePx: int('DESIGNSTUDIO_INPUT_MAX_EDGE', 1536, { min: 256, max: 4096 }),
    jpegQuality: int('DESIGNSTUDIO_INPUT_QUALITY', 92, { min: 50, max: 100 }),
    // Below this the result will lose fine detail; the caller gets a warning.
    lowResolutionPx: 512,
    // Gemini refuses requests whose inline data passes ~20 MB. Ten highly detailed
    // photos measured 18 MB after normal preparation, so above this total the
    // largest images are re-encoded smaller until the request fits.
    modelRequestBudgetBytes: int('DESIGNSTUDIO_MODEL_REQUEST_MB', 14, { min: 2, max: 19 }) * 1024 * 1024,
    // Below this there is nothing usable to copy; refused.
    minEdgePx: 64,
    maxInputPixels: 60_000_000
  },

  output: {
    // jpeg: re-encoded at high quality, ~10x smaller than the model's PNG, so the
    // base64 in the stream stays manageable. original: exactly what the model sent.
    format: (process.env.DESIGNSTUDIO_OUTPUT_FORMAT || 'jpeg').toLowerCase() === 'original' ? 'original' : 'jpeg',
    jpegQuality: int('DESIGNSTUDIO_OUTPUT_QUALITY', 95, { min: 50, max: 100 })
  },

  stream: {
    heartbeatMs: int('DESIGNSTUDIO_HEARTBEAT_MS', 10000, { min: 50 })
  }
};

module.exports = { config };
