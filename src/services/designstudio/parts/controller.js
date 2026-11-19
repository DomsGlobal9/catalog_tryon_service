// =============================================================================
// parts/controller.js — POST /api/v1/designstudio/parts, start to finish (since 19 Nov 2026).
// =============================================================================
//
// A boutique opens a design and clicks "Make part images": from its own photo(s) of the garment,
// one clear close-up of each part (a blouse's front, back, neck, sleeve and hand; a saree's
// pallu, border, body, pleats, zari...). The boutique keeps, redoes or drops each one; nothing is
// stored here beyond GET /result's 15 minutes.
//
// Same plumbing as /generate and /sketch:
//   before the stream: validate (400), load the photos (422), admit (429) - one job per client
//   across all Design Studio endpoints, cancelled by POST /cancel, collected by GET /result/:jobId.
//   the stream: start -> located (where each part was found, or why not) -> one `part` per part
//   as it is ready (parts are made side by side, so they arrive in any order) -> done. Or `error`.
//
// One part failing never sinks the others: if its sharp close-up cannot be made, the part comes
// back as cut from the photo (enhanced: false) with the reason, and Redo asks for that part alone.

const crypto = require('crypto');
const { config } = require('../config');
const { StudioError, redact } = require('../errors');
const { prepareImages } = require('../imageInput');
const resultStore = require('../resultStore');
const { imageOnly, PIPELINE } = require('../controller');
const { admitGeneration } = require('../../../middleware/generationGuard');
const { resolvePartsRequest } = require('./request');
const { locateParts } = require('./locate');
const { cutPart } = require('./cut');
const { enhancePart } = require('./enhance');

const MESSAGES = {
  not_visible: (p, job) => `The ${p.name.toLowerCase()} is not in ${job.photos.length > 1 ? 'these photos' : 'this photo'}. Send a photo that shows it.`,
  too_small: (p) => `The ${p.name.toLowerCase()} is too small in the photo to show its design. Send a closer photo of it.`
};

/** Run fn over items, at most `limit` at a time. */
async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

const dataUri = (image) => `data:${image.mimeType};base64,${image.base64}`;

/** How much two boxes (0-1000) cover the same place: intersection over union. */
function overlap(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return union > 0 ? inter / union : 0;
}
const SAME_SPOT = 0.75;

/** Found parts grouped so that parts in the same place of the same photo are made once. */
function groupSameSpot(found) {
  const groups = [];
  for (const f of found) {
    const g = groups.find((x) => x.lead.photo === f.photo && overlap(x.lead.box, f.box) >= SAME_SPOT);
    if (g) g.followers.push(f); else groups.push({ lead: f, followers: [] });
  }
  return groups;
}

async function parts(req, res, next) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const abort = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) abort.abort(); });

  let job;
  let admitted;
  try {
    job = resolvePartsRequest(req.body);
    const prepStarted = Date.now();
    await prepareImages(job, abort.signal);
    job.prepareMs = Date.now() - prepStarted;
    if (abort.signal.aborted) return;
    admitted = await admitGeneration(req, res, { clientId: job.clientId, pipeline: PIPELINE });
    if (!admitted) return; // 429 already sent
  } catch (err) {
    finished = true;
    if (err instanceof StudioError && err.code === 'CANCELLED') return;
    logOutcome({ requestId, req, job, startedAt, outcome: err.code || 'ERROR' });
    return next(err);
  }

  admitted.job.signal.addEventListener('abort', () => abort.abort());
  if (admitted.job.signal.aborted) abort.abort();

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const jobId = admitted.job.id;
  resultStore.begin(jobId, req.account);
  const send = (event) => {
    const out = config.stream.detail === 'full' ? event : imageOnly(event);
    resultStore.record(jobId, out);
    if (res.writableEnded || res.destroyed) return;
    if (out) res.write(`data: ${JSON.stringify(out)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(`: keepalive ${Date.now()}\n\n`);
  }, config.stream.heartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

  let outcome = 'ERROR';
  let attempts = 0;
  const summary = { made: 0, enhanced: 0, notFound: 0, fallback: 0 };
  try {
    const lowRes = job.photos.filter((p) => p.image.lowResolution).map((p) => p.field);
    send({
      type: 'start', requestId, jobId, endpoint: 'parts', garment: job.garmentId, parts: job.parts.map((p) => p.areaId),
      photos: job.photos.length, enhance: job.enhance,
      warnings: [...job.inputWarnings, ...(lowRes.length ? [`${lowRes.join(', ')} ${lowRes.length > 1 ? 'are' : 'is'} small; close-ups from it will show little detail.`] : [])]
    });

    // Step one: where is each part?
    send({ type: 'status', stage: 'locating', message: `Finding the parts in the photo${job.photos.length > 1 ? 's' : ''}.` });
    const locateStarted = Date.now();
    const located = await locateParts(job, { signal: abort.signal });
    job.locateMs = Date.now() - locateStarted;
    if (!located.answeredPhotos) {
      console.warn(`[DesignStudio] requestId=${requestId} parts not located: ${located.problems.join('; ')}`);
      throw new StudioError('The photo could not be read just now. Please try again in a moment.', { status: 424, code: 'PARTS_NOT_LOCATED', retryable: true });
    }
    send({
      type: 'located',
      jobId,
      parts: located.found.map((f) => ({
        area: f.areaId, name: f.name, found: f.status === 'found',
        ...(f.status === 'found' ? { photo: f.photo.index, view: f.photo.view, visible: f.visible } : { reason: f.status.toUpperCase() }),
        note: f.note || null
      }))
    });

    // The parts no photo shows: answered at once, nothing is made for them.
    for (const f of located.found.filter((x) => x.status !== 'found')) {
      summary.notFound += 1;
      send({ type: 'part', jobId, area: f.areaId, name: f.name, found: false, reason: f.status.toUpperCase(), message: MESSAGES[f.status](f, job) });
    }

    // Step two: each found part, cut and made sharp, side by side. Parts found in the same place of
    // the same photo (a saree's border and its zari work, measured 19 Nov) are made once and sent
    // under each name, marked sameAs.
    const generationStarted = Date.now();
    const groups = groupSameSpot(located.found.filter((f) => f.status === 'found'));
    await pool(groups, config.parts.concurrency, async ({ lead, followers }) => {
      if (abort.signal.aborted) return;
      const part = job.parts.find((p) => p.areaId === lead.areaId);
      const cut = await cutPart(lead.photo.image, lead.box);
      const source = { photo: lead.photo.index, box: [lead.box.y0, lead.box.x0, lead.box.y1, lead.box.x1], cut: { width: cut.rect.width, height: cut.rect.height } };
      const deliver = (fields) => {
        for (const [i, f] of [lead, ...followers].entries()) {
          summary.made += 1;
          if (fields.enhanced) summary.enhanced += 1;
          if (fields.error) summary.fallback += 1;
          send({ type: 'part', jobId, area: f.areaId, name: f.name, found: true, source, lowDetail: cut.lowDetail, ...(i ? { sameAs: lead.areaId } : {}), ...fields });
        }
      };
      if (!job.enhance) {
        deliver({ enhanced: false, mimeType: cut.image.mimeType, width: cut.image.width, height: cut.image.height, image: dataUri(cut.image) });
        return;
      }
      send({ type: 'status', stage: 'making', area: lead.areaId, message: `Making the ${lead.name.toLowerCase()} close-up.` });
      try {
        const made = await enhancePart(job, part, cut, { signal: abort.signal });
        attempts += made.attempts;
        deliver({ enhanced: true, quality: made.quality, mimeType: made.image.mimeType, width: made.image.width, height: made.image.height, image: dataUri(made.image) });
      } catch (err) {
        if ((err instanceof StudioError && err.code === 'CANCELLED') || abort.signal.aborted) throw err;
        console.warn(`[DesignStudio] requestId=${requestId} part ${lead.areaId} not enhanced: ${err.code || ''} ${redact(err.message || '')}`);
        deliver({
          enhanced: false, mimeType: cut.image.mimeType, width: cut.image.width, height: cut.image.height, image: dataUri(cut.image),
          error: { code: err.code || 'ENHANCE_FAILED', retryable: true, message: 'The sharp close-up could not be made just now; this is the part as cut from your photo. Redo this part to try again.' }
        });
      }
    });
    if (abort.signal.aborted) throw new StudioError('Generation cancelled.', { status: 499, code: 'CANCELLED' });

    send({
      type: 'done', jobId, status: 'ok', endpoint: 'parts', summary, attempts,
      timings: { prepareMs: job.prepareMs, locateMs: job.locateMs, generateMs: Date.now() - generationStarted, totalMs: Date.now() - startedAt }
    });
    outcome = 'OK';
  } catch (err) {
    if ((err instanceof StudioError && err.code === 'CANCELLED') || abort.signal.aborted) {
      outcome = 'CANCELLED';
      send({ type: 'error', jobId, code: 'CANCELLED', message: 'Generation was cancelled.', retryable: false });
    } else if (err instanceof StudioError) {
      outcome = err.code;
      send({ type: 'error', jobId, ...err.toJSON() });
    } else {
      outcome = 'INTERNAL_ERROR';
      console.error(`[DesignStudio] requestId=${requestId} parts crashed:`, redact(err && err.stack ? err.stack : err));
      send({ type: 'error', jobId, code: 'INTERNAL_ERROR', message: 'Making the part images failed unexpectedly.', retryable: true });
    }
  } finally {
    finished = true;
    clearInterval(heartbeat);
    await admitted.release();
    if (!res.writableEnded && !res.destroyed) res.end();
    logOutcome({ requestId, req, job, startedAt, outcome, attempts, summary, jobId });
  }
}

function logOutcome({ requestId, req, job, startedAt, outcome, attempts = 0, summary = null, jobId = null }) {
  const who = req.account ? `account=${req.account} ` : '';
  const what = job ? `garment=${job.garmentId} photos=${job.photos.length} parts=${job.parts.length} enhance=${job.enhance} ` : '';
  const made = summary ? `made=${summary.made} enhanced=${summary.enhanced} notFound=${summary.notFound} fallback=${summary.fallback} ` : '';
  console.log(`[DesignStudio] requestId=${requestId} ${jobId ? `jobId=${jobId} ` : ''}endpoint=parts ${who}${what}${made}attempts=${attempts} outcome=${outcome} totalMs=${Date.now() - startedAt}`);
}

module.exports = { parts, pool, overlap, groupSameSpot };
