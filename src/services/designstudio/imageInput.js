// =============================================================================
// imageInput.js — turn each base64 string or Cloudinary link into a clean image.
// =============================================================================
//
// For every image:
//   1. get the bytes: decode base64, or download the link (allowed hosts only,
//      https only, size and time capped, every redirect re-checked);
//   2. prove it is really an image by decoding it (the declared type is not trusted);
//   3. normalise it: honour EXIF rotation, flatten transparency onto white,
//      shrink to the model's useful size, re-encode as high-quality JPEG.
//
// All images are prepared in parallel. If any fail, every failure is reported
// together, so a caller fixes their payload in one round trip rather than five.
//
const sharp = require('sharp');
const { config } = require('./config');
const { StudioError } = require('./errors');
const { hostAllowed } = require('./validate');

let fetchImpl = (...args) => fetch(...args);

const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'heif', 'gif', 'tiff']);

class ImageProblem extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function readCapped(response, maxBytes, field) {
  const declared = Number(response.headers.get('content-length'));
  if (declared && declared > maxBytes) {
    throw new ImageProblem('IMAGE_TOO_LARGE', `${field} is ${(declared / 1024 / 1024).toFixed(1)} MB; the limit is ${maxBytes / 1024 / 1024} MB.`);
  }
  if (!response.body) return Buffer.from(await response.arrayBuffer());

  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ImageProblem('IMAGE_TOO_LARGE', `${field} is larger than ${maxBytes / 1024 / 1024} MB.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/** Download one allowed link. Retries once on a dropped connection or a 5xx. */
async function download(url, field, signal) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await downloadOnce(url, field, signal);
    } catch (err) {
      lastError = err;
      if (signal && signal.aborted) throw err;
      // A dropped connection or a 5xx is worth one more try; a timeout already
      // waited the full limit and would only double the wait.
      const timedOut = err && err.name === 'TimeoutError';
      const transient = (!(err instanceof ImageProblem) && !timedOut) || err.code === 'IMAGE_DOWNLOAD_FAILED_TRANSIENT';
      if (!transient || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (lastError instanceof ImageProblem) {
    if (lastError.code === 'IMAGE_DOWNLOAD_FAILED_TRANSIENT') lastError.code = 'IMAGE_DOWNLOAD_FAILED';
    throw lastError;
  }
  const timedOut = lastError && (lastError.name === 'TimeoutError' || /timeout/i.test(lastError.message));
  throw new ImageProblem('IMAGE_DOWNLOAD_FAILED', timedOut
    ? `${field} did not download within ${config.input.downloadTimeoutMs / 1000}s.`
    : `${field} could not be downloaded.`);
}

async function downloadOnce(startUrl, field, signal) {
  let url = startUrl;
  const timeout = AbortSignal.timeout(config.input.downloadTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  for (let hop = 0; hop <= config.input.maxRedirects; hop++) {
    const response = await fetchImpl(url.href, {
      redirect: 'manual',
      signal: combined,
      headers: { Accept: 'image/*' }
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new ImageProblem('IMAGE_DOWNLOAD_FAILED', `${field} redirected without a destination.`);
      const next = new URL(location, url);
      // A redirect must not be a way around the host allowlist.
      if (next.protocol !== 'https:' || !hostAllowed(next.hostname)) {
        throw new ImageProblem('IMAGE_SOURCE_NOT_ALLOWED', `${field} redirected to ${next.hostname}, which is not an allowed image host.`);
      }
      url = next;
      continue;
    }

    if (response.status === 404 || response.status === 410) {
      throw new ImageProblem('IMAGE_NOT_FOUND', `${field} was not found (HTTP ${response.status}).`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ImageProblem('IMAGE_NOT_ACCESSIBLE', `${field} is not publicly accessible (HTTP ${response.status}).`);
    }
    if (response.status >= 500) {
      throw new ImageProblem('IMAGE_DOWNLOAD_FAILED_TRANSIENT', `${field} could not be downloaded (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      throw new ImageProblem('IMAGE_DOWNLOAD_FAILED', `${field} could not be downloaded (HTTP ${response.status}).`);
    }
    return readCapped(response, config.limits.maxImageBytes, field);
  }
  throw new ImageProblem('IMAGE_DOWNLOAD_FAILED', `${field} redirected too many times.`);
}

/** Decode, verify and normalise one image. */
async function normalise(buffer, field) {
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: config.input.maxInputPixels }).metadata();
  } catch {
    throw new ImageProblem('INVALID_IMAGE', `${field} is not a readable image.`);
  }
  if (!ACCEPTED_FORMATS.has(meta.format)) {
    throw new ImageProblem('UNSUPPORTED_IMAGE_FORMAT', `${field} is ${meta.format || 'an unknown format'}; send JPEG, PNG, WebP, AVIF or HEIC.`);
  }

  // Width/height as displayed, after EXIF rotation.
  const rotated = meta.orientation && meta.orientation >= 5;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;
  if (!width || !height || Math.max(width, height) < config.input.minEdgePx) {
    throw new ImageProblem('IMAGE_TOO_SMALL', `${field} is ${width}x${height}px; it needs to be at least ${config.input.minEdgePx}px on its longest side.`);
  }

  let output;
  try {
    output = await sharp(buffer, { limitInputPixels: config.input.maxInputPixels, pages: 1 })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: config.input.maxEdgePx, height: config.input.maxEdgePx, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: config.input.jpegQuality, chromaSubsampling: '4:4:4' })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new ImageProblem('INVALID_IMAGE', `${field} could not be processed as an image.`);
  }

  return {
    mimeType: 'image/jpeg',
    base64: output.data.toString('base64'),
    original: { width, height, format: meta.format, bytes: buffer.length },
    sent: { width: output.info.width, height: output.info.height, bytes: output.data.length },
    lowResolution: Math.max(width, height) < config.input.lowResolutionPx
  };
}

async function prepareOne(source, field, signal) {
  const buffer = source.kind === 'url'
    ? await download(source.url, field, signal)
    : Buffer.from(source.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!buffer.length) throw new ImageProblem('INVALID_IMAGE', `${field} is empty.`);
  const image = await normalise(buffer, field);
  return { ...image, from: source.kind === 'url' ? 'url' : 'base64' };
}

/**
 * Prepare every image in a resolved job, in parallel.
 * Adds `.image` to each design, fabric and the model reference.
 *
 * @throws StudioError 422 listing every image that failed.
 */
async function prepareImages(job, signal) {
  const tasks = [
    ...job.designs.map((d) => ({ target: d, field: `designs[${d.index}].image` })),
    ...job.fabrics.map((f) => ({ target: f, field: `fabrics[${f.index}].image` })),
    ...(job.model.kind === 'reference' ? [{ target: job.model, field: 'modelImage' }] : [])
  ];

  const settled = await Promise.allSettled(tasks.map((t) => prepareOne(t.target.source, t.field, signal)));
  if (signal && signal.aborted) throw new StudioError('Request cancelled.', { status: 499, code: 'CANCELLED' });

  const problems = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      tasks[i].target.image = result.value;
    } else {
      const err = result.reason;
      if (!(err instanceof ImageProblem)) {
        console.error(`[DesignStudio] unexpected image error for ${tasks[i].field}:`, err && err.stack ? err.stack : err);
      }
      problems.push({
        field: tasks[i].field,
        code: err instanceof ImageProblem ? err.code : 'INVALID_IMAGE',
        message: err instanceof ImageProblem ? err.message : `${tasks[i].field} could not be processed.`
      });
    }
  });

  if (problems.length) {
    throw new StudioError(
      problems.length === 1 ? problems[0].message : `${problems.length} images could not be used: ${problems.map((p) => p.field).join(', ')}.`,
      { status: 422, code: 'IMAGE_UNUSABLE', details: problems, retryable: problems.every((p) => p.code === 'IMAGE_DOWNLOAD_FAILED') }
    );
  }

  await fitRequestBudget(tasks.map((t) => t.target.image));
  return tasks.map((t) => ({ field: t.field, ...t.target.image }));
}

// Progressively smaller settings, tried on the largest images first.
const SHRINK_STEPS = [
  { edge: 1280, quality: 85 },
  { edge: 1024, quality: 80 },
  { edge: 896, quality: 72 }
];

/**
 * Keep the total sent to the model under its request limit. Typical photos never
 * trigger this; ten noisy, detailed ones do. Mutates the prepared images.
 */
async function fitRequestBudget(images) {
  const budget = config.input.modelRequestBudgetBytes;
  const total = () => images.reduce((sum, img) => sum + img.base64.length, 0);
  for (const step of SHRINK_STEPS) {
    if (total() <= budget) return;
    for (const img of [...images].sort((a, b) => b.base64.length - a.base64.length)) {
      if (total() <= budget) return;
      if (Math.max(img.sent.width, img.sent.height) <= step.edge && img.sentQuality !== undefined && img.sentQuality <= step.quality) continue;
      const { data, info } = await sharp(Buffer.from(img.base64, 'base64'))
        .resize({ width: step.edge, height: step.edge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: step.quality })
        .toBuffer({ resolveWithObject: true });
      if (data.length * 4 / 3 < img.base64.length) {
        img.base64 = data.toString('base64');
        img.sent = { width: info.width, height: info.height, bytes: data.length };
        img.sentQuality = step.quality;
        img.shrunkToFit = true;
      }
    }
  }
  if (total() > budget) {
    throw new StudioError(
      `The images are too detailed to send together (${(total() / 1024 / 1024).toFixed(1)} MB after compression). Send fewer or smaller images.`,
      { status: 422, code: 'IMAGE_UNUSABLE', details: [{ field: '(all images)', code: 'REQUEST_TOO_LARGE_FOR_MODEL' }] }
    );
  }
}

module.exports = { prepareImages, normalise, fitRequestBudget, _setFetch: (fn) => { fetchImpl = fn; } };
