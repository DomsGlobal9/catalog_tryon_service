// =============================================================================
// geminiImage.js — one image generation call, done carefully.
// =============================================================================
//
//   * a time limit per attempt AND one for the whole generation, so retries can
//     never keep a caller waiting forever;
//   * retries only what can succeed on retry: busy (429), unavailable (5xx), a
//     dropped connection, or an answer that came back without an image;
//   * never retries a refusal (safety block) or a rejected request (400) - both
//     would fail again and cost again;
//   * the response body is read INSIDE the retry loop: image responses are
//     megabytes, and the read is the likeliest place for a connection to drop;
//   * Gemini 3 image models "think" and may emit draft images first. Only the
//     final, non-thought image is returned.
//
const sharp = require('sharp');
const { config } = require('./config');
const { StudioError, redact } = require('./errors');

let fetchImpl = (...args) => fetch(...args);
let sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BLOCK_REASONS = new Set([
  'SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'IMAGE_PROHIBITED_CONTENT',
  'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_RECITATION'
]);

const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);

class RetryableFailure extends Error {
  constructor(message, { kind, retryAfterMs = 0 } = {}) {
    super(message);
    this.kind = kind; // 'busy' | 'no_image'
    this.retryAfterMs = retryAfterMs;
  }
}

function buildRequest(parts) {
  const generationConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { aspectRatio: config.gemini.aspectRatio, imageSize: config.gemini.imageSize }
  };
  if (config.gemini.temperature !== null && Number.isFinite(config.gemini.temperature)) {
    generationConfig.temperature = config.gemini.temperature;
  }
  return { contents: [{ role: 'user', parts }], generationConfig };
}

/** Pull the final image (and any explanation) out of a response. */
function extract(json) {
  const blockReason = json && json.promptFeedback && json.promptFeedback.blockReason;
  if (blockReason) return { blocked: blockReason };

  const candidate = json && Array.isArray(json.candidates) ? json.candidates[0] : null;
  if (!candidate) return { image: null, text: '', finishReason: 'NO_CANDIDATE' };

  const finishReason = candidate.finishReason || 'UNKNOWN';
  const parts = (candidate.content && candidate.content.parts) || [];
  let image = null;
  const text = [];
  for (const part of parts) {
    if (part.thought) continue; // draft thinking output, never the answer
    const inline = part.inlineData || part.inline_data;
    if (inline && inline.data) image = { data: inline.data, mimeType: inline.mimeType || inline.mime_type || 'image/png' };
    else if (typeof part.text === 'string') text.push(part.text);
  }
  if (!image && BLOCK_REASONS.has(finishReason)) return { blocked: finishReason, text: text.join(' ') };
  return { image, text: text.join(' ').trim(), finishReason, usage: json.usageMetadata || null };
}

async function attempt(body, signal, timeoutMs) {
  const url = `${config.gemini.baseUrl}/models/${encodeURIComponent(config.gemini.model)}:generateContent`;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response;
  let json;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey() },
      body,
      signal: combined
    });
    if (RETRYABLE_HTTP.has(response.status)) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const detail = await response.text().catch(() => '');
      // A 429 means two very different things. "Too many requests right now" is
      // worth retrying; a spent spending cap or exhausted billing quota never
      // succeeds on retry, so retrying only wastes the caller's time.
      if (/spending cap|spend cap|billing|budget|exceeded its monthly/i.test(detail)) {
        console.error(`[DesignStudio] image model quota/spending cap reached: ${redact(detail).slice(0, 200)}`);
        throw new StudioError(
          'The image model has reached its spending cap or quota for this deployment. Generation is unavailable until that is raised.',
          { status: 424, code: 'MODEL_QUOTA_EXCEEDED' }
        );
      }
      throw new RetryableFailure(`image model busy (HTTP ${response.status}) ${redact(detail).slice(0, 160)}`,
        { kind: 'busy', retryAfterMs: Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 10000) : 0 });
    }
    const raw = await response.text();
    try {
      json = JSON.parse(raw);
    } catch {
      if (response.ok) throw new RetryableFailure('image model returned an unreadable response', { kind: 'busy' });
      json = { rawError: raw };
    }
  } catch (err) {
    if (signal && signal.aborted) throw new StudioError('Generation cancelled.', { status: 499, code: 'CANCELLED' });
    // Decisions already made above (a spending cap, a refusal) must not be
    // re-wrapped as a connection problem and retried.
    if (err instanceof StudioError || err instanceof RetryableFailure) throw err;
    if (err && err.name === 'TimeoutError') {
      throw new RetryableFailure(`image model did not answer within ${Math.round(timeoutMs / 1000)}s`, { kind: 'timeout' });
    }
    throw new RetryableFailure(`connection to the image model failed: ${redact(err && err.message)}`, { kind: 'busy' });
  }

  if (!response.ok) {
    const message = redact((json.error && json.error.message) || json.rawError || `HTTP ${response.status}`);
    if (response.status === 401 || response.status === 403) {
      console.error(`[DesignStudio] image model rejected our credentials: ${message}`);
      throw new StudioError('The image model is not available on this deployment.', { status: 424, code: 'MODEL_UNAVAILABLE' });
    }
    if (response.status === 404) {
      console.error(`[DesignStudio] image model ${config.gemini.model} not found: ${message}`);
      throw new StudioError('The image model is not available on this deployment.', { status: 424, code: 'MODEL_UNAVAILABLE' });
    }
    // 400: the model refused this input (or our request shape is wrong - logged).
    console.warn(`[DesignStudio] image model rejected the request (HTTP ${response.status}): ${message}`);
    throw new StudioError(`The image model could not process this request: ${message}`, { status: 422, code: 'GENERATION_REJECTED' });
  }

  const result = extract(json);
  if (result.blocked) {
    throw new StudioError(
      `The image model declined to generate this image (${result.blocked}). Try different reference images.`,
      { status: 422, code: 'GENERATION_BLOCKED', details: { reason: result.blocked } }
    );
  }
  if (!result.image) {
    throw new RetryableFailure(`the image model answered without an image (${result.finishReason}${result.text ? `: ${redact(result.text).slice(0, 160)}` : ''})`,
      { kind: 'no_image' });
  }
  return result;
}

/** Re-encode the model's image for delivery and measure it. */
async function finishImage(image) {
  const input = Buffer.from(image.data, 'base64');
  if (config.output.format === 'original') {
    const meta = await sharp(input).metadata();
    return { mimeType: image.mimeType, base64: image.data, width: meta.width, height: meta.height, bytes: input.length };
  }
  const { data, info } = await sharp(input)
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: config.output.jpegQuality, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { mimeType: 'image/jpeg', base64: data.toString('base64'), width: info.width, height: info.height, bytes: data.length };
}

/**
 * @param {Object[]} parts   From promptBuilder.
 * @param {Object}   options
 * @param {AbortSignal} [options.signal]
 * @param {(info: Object) => void} [options.onAttempt]  Called before each attempt.
 * @returns {Promise<{ image: Object, attempts: number, usage: Object|null, modelText: string, finishReason: string }>}
 */
async function generateImage(parts, { signal, onAttempt } = {}) {
  if (!config.gemini.apiKey()) {
    throw new StudioError('The image model is not configured on this deployment.', { status: 424, code: 'MODEL_NOT_CONFIGURED' });
  }

  const body = JSON.stringify(buildRequest(parts));
  const deadline = Date.now() + config.gemini.deadlineMs;
  let busyRetries = 0;
  let noImageRetries = 0;
  let timeoutRetries = 0;
  let attempts = 0;
  let lastFailure = null;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining < 1000) break;
    attempts += 1;
    if (onAttempt) onAttempt({ attempt: attempts, reason: lastFailure ? lastFailure.kind : null });

    try {
      const result = await attempt(body, signal, Math.min(config.gemini.attemptTimeoutMs, remaining));
      const image = await finishImage(result.image);
      return { image, attempts, usage: result.usage, modelText: result.text, finishReason: result.finishReason };
    } catch (err) {
      if (!(err instanceof RetryableFailure)) throw err;
      lastFailure = err;
      console.warn(`[DesignStudio] attempt ${attempts} failed: ${err.message}`);

      const canRetry = err.kind === 'no_image' ? noImageRetries++ < config.gemini.noImageRetries
        : err.kind === 'timeout' ? timeoutRetries++ < config.gemini.timeoutRetries
        : err.kind === 'busy' && busyRetries++ < config.gemini.retries;
      if (!canRetry) break;

      const attemptsSoFar = busyRetries + noImageRetries + timeoutRetries;
      const wait = Math.max(err.retryAfterMs, config.gemini.retryBaseMs * 2 ** Math.max(0, attemptsSoFar - 1)) + Math.floor(Math.random() * 500);
      if (Date.now() + wait + 1000 >= deadline) break;
      await sleep(wait);
      if (signal && signal.aborted) throw new StudioError('Generation cancelled.', { status: 499, code: 'CANCELLED' });
    }
  }

  if (lastFailure && lastFailure.kind === 'timeout') {
    throw new StudioError(
      `The image model did not answer in time (${attempts} attempt${attempts === 1 ? '' : 's'} of ${Math.round(config.gemini.attemptTimeoutMs / 1000)}s). Please retry shortly.`,
      { status: 424, code: 'MODEL_TIMEOUT', retryable: true }
    );
  }
  if (lastFailure && lastFailure.kind === 'no_image') {
    throw new StudioError(`The image model did not return an image after ${attempts} attempt${attempts === 1 ? '' : 's'}. Try again, or simplify the references.`,
      { status: 422, code: 'NO_IMAGE_RETURNED', retryable: true });
  }
  throw new StudioError(
    `The image model is unavailable right now (${lastFailure ? lastFailure.message : 'time limit reached'}). Please retry shortly.`,
    { status: 424, code: 'MODEL_UNAVAILABLE', retryable: true }
  );
}

module.exports = {
  generateImage, extract, buildRequest,
  _setFetch: (fn) => { fetchImpl = fn; },
  _setSleep: (fn) => { sleep = fn; }
};
