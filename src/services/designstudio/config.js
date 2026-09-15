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
    attemptTimeoutMs: int('DESIGNSTUDIO_ATTEMPT_TIMEOUT_MS', 120000, { min: 1000 }),
    // Hard ceiling for the whole generation including retries.
    deadlineMs: int('DESIGNSTUDIO_DEADLINE_MS', 170000, { min: 1000 }),
    // Extra tries after a busy/unavailable answer (429, 5xx, dropped connection).
    retries: int('DESIGNSTUDIO_RETRIES', 2, { max: 5 }),
    // Extra tries when the model answers but returns no image.
    noImageRetries: int('DESIGNSTUDIO_NO_IMAGE_RETRIES', 1, { max: 3 }),
    retryBaseMs: int('DESIGNSTUDIO_RETRY_BASE_MS', 2000)
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
