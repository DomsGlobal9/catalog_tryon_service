// =============================================================================
// controller.js — the Design Studio request, start to finish.
// =============================================================================
//
// POST /generate
//
//   before the stream (plain JSON errors, nothing charged):
//     1. validate      shape, garment, areas, fabrics, image sources      -> 400
//     2. images        decode / download, verify, normalise                -> 422
//     3. admit         customer's hourly budget, server capacity, replace
//                      this client's previous job                          -> 429
//   the stream (text/event-stream):
//     4. start         what will be made, plus any warnings
//     5. generating    one Gemini call; keep-alive pings while it works
//     6. image         the photograph as base64
//     7. done          timings
//   or `error` in place of 6-7. Never a 5xx for an anticipated failure.
//
const crypto = require('crypto');
const { config } = require('./config');
const { StudioError, redact } = require('./errors');
const { resolveRequest } = require('./validate');
const { prepareImages } = require('./imageInput');
const { buildPrompt, referenceList } = require('./promptBuilder');
const { describeReferences } = require('./describeReferences');
const { generateImage } = require('./geminiImage');
const { garmentGuide, taxonomy } = require('./garmentGuide');
const { admitGeneration, cancelGeneration } = require('../../middleware/generationGuard');

const PIPELINE = 'designstudio';

async function generate(req, res, next) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const abort = new AbortController();
  let finished = false;
  // 'close' also fires after a normal end; only an early close is the caller leaving.
  res.on('close', () => { if (!finished) abort.abort(); });

  let job;
  let prepared;
  let admitted;
  let prompt;
  try {
    job = resolveRequest(req.body);
    const prepStarted = Date.now();
    prepared = await prepareImages(job, abort.signal);
    job.prepareMs = Date.now() - prepStarted;
    prompt = buildPrompt(job); // provisional: replaced below if the references get described

    if (abort.signal.aborted) return;
    admitted = await admitGeneration(req, res, { clientId: job.clientId, pipeline: PIPELINE });
    if (!admitted) return; // 429 already sent
  } catch (err) {
    finished = true;
    if (err instanceof StudioError && err.code === 'CANCELLED') return;
    logOutcome({ requestId, req, job, startedAt, outcome: err.code || 'ERROR' });
    return next(err);
  }

  // The job can now be cancelled from anywhere (cancel endpoint, another server,
  // a newer job from the same client).
  admitted.job.signal.addEventListener('abort', () => abort.abort());

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(`: keepalive ${Date.now()}\n\n`);
  }, config.stream.heartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

  let outcome = 'ERROR';
  let attempts = 0;
  let usage = null;
  try {
    send({
      type: 'start',
      requestId,
      jobId: admitted.job.id,
      garment: job.garmentId,
      designs: job.designs.map((d) => ({ index: d.index, area: d.areaId, areaName: d.areaName })),
      // itemCode is echoed back so the caller can match the photo to their stock.
      fabrics: job.fabrics.map((f) => ({ index: f.index, name: f.name, itemCode: f.itemCode, color: f.colorHex || f.color, appliesTo: f.appliesTo || 'MAIN' })),
      productName: job.productName,
      model: job.model.kind,
      pose: prompt.pose,
      aspectRatio: config.gemini.aspectRatio,
      warnings: prompt.warnings
    });

    // Step one: put the references into words, so the image model cannot quietly
    // simplify a temple border into plain bands. Optional and never fatal.
    if (config.describe.enabled) {
      send({ type: 'status', stage: 'reading-references', message: 'Reading the designs and fabrics.' });
      const describeStarted = Date.now();
      const descriptions = await describeReferences(referenceList(job), { signal: abort.signal });
      job.describeMs = Date.now() - describeStarted;
      if (descriptions.size) {
        prompt = buildPrompt(job, { descriptions });
        send({
          type: 'brief',
          jobId: admitted.job.id,
          references: [...descriptions.entries()].map(([ref, info]) => ({ ref, ...info }))
        });
      }
    }

    const generationStarted = Date.now();
    const result = await generateImage(prompt.parts, {
      signal: abort.signal,
      onAttempt: ({ attempt, reason }) => send({
        type: 'status',
        stage: 'generating',
        attempt,
        message: attempt === 1 ? 'Generating the garment.' : `Retrying (${reason === 'no_image' ? 'no image was returned' : 'the image model was busy'}).`
      })
    });
    attempts = result.attempts;
    usage = result.usage;

    send({
      type: 'image',
      jobId: admitted.job.id,
      mimeType: result.image.mimeType,
      width: result.image.width,
      height: result.image.height,
      bytes: result.image.bytes,
      image: `data:${result.image.mimeType};base64,${result.image.base64}`
    });
    send({
      type: 'done',
      jobId: admitted.job.id,
      status: 'ok',
      attempts,
      timings: { prepareMs: job.prepareMs, describeMs: job.describeMs || 0, generateMs: Date.now() - generationStarted, totalMs: Date.now() - startedAt }
    });
    outcome = 'OK';
  } catch (err) {
    if (err instanceof StudioError && err.code === 'CANCELLED') {
      outcome = 'CANCELLED';
      send({ type: 'error', jobId: admitted.job.id, code: 'CANCELLED', message: 'Generation was cancelled.', retryable: false });
    } else if (err instanceof StudioError) {
      outcome = err.code;
      send({ type: 'error', jobId: admitted.job.id, ...err.toJSON() });
    } else {
      outcome = 'INTERNAL_ERROR';
      console.error(`[DesignStudio] requestId=${requestId} crashed:`, redact(err && err.stack ? err.stack : err));
      send({ type: 'error', jobId: admitted.job.id, code: 'INTERNAL_ERROR', message: 'Generation failed unexpectedly.', retryable: true });
    }
  } finally {
    finished = true;
    clearInterval(heartbeat);
    await admitted.release();
    if (!res.writableEnded && !res.destroyed) res.end();
    logOutcome({ requestId, req, job, startedAt, outcome, attempts, usage, prepared, jobId: admitted.job.id });
  }
}

function logOutcome({ requestId, req, job, startedAt, outcome, attempts = 0, usage = null, prepared = null, jobId = null }) {
  const who = req.account ? `account=${req.account} ` : '';
  const what = job ? `garment=${job.garmentId} designs=${job.designs.length} fabrics=${job.fabrics.length} model=${job.model.kind} ` : '';
  const inputKb = prepared ? `inputKB=${Math.round(prepared.reduce((s, p) => s + p.sent.bytes, 0) / 1024)} ` : '';
  const tokens = usage ? `tokens=${usage.promptTokenCount || 0}/${usage.candidatesTokenCount || 0} ` : '';
  console.log(`[DesignStudio] requestId=${requestId} ${jobId ? `jobId=${jobId} ` : ''}${who}client=${job ? job.clientId : '-'} ${what}${inputKb}${tokens}attempts=${attempts} outcome=${outcome} ${Date.now() - startedAt}ms`);
}

/** POST /cancel  { clientId } */
async function cancel(req, res, next) {
  try {
    const clientId = req.body && typeof req.body.clientId === 'string' ? req.body.clientId.trim() : '';
    if (!clientId || clientId.length > 128) {
      throw new StudioError('clientId is required (1-128 characters).', { status: 400, code: 'VALIDATION_ERROR' });
    }
    const found = await cancelGeneration(req, { clientId, pipeline: PIPELINE });
    res.json({ success: true, cancelled: found, message: found ? 'Generation cancelled.' : 'No generation is running for this client.' });
  } catch (err) {
    next(err);
  }
}

/** GET /options  - everything a client needs to build a valid request. */
function options(_req, res) {
  res.json({
    success: true,
    model: { aspectRatio: config.gemini.aspectRatio, output: config.output.format === 'jpeg' ? 'image/jpeg (base64)' : 'as generated (base64)' },
    limits: {
      maxDesigns: config.limits.maxDesigns,
      maxFabrics: config.limits.maxFabrics,
      maxImageMb: config.limits.maxImageBytes / 1024 / 1024,
      maxRequestMb: config.limits.maxBodyMb
    },
    images: {
      accepted: ['base64 (raw or data:image/...;base64,)', `https links on ${config.input.allowedHosts.join(', ')}`],
      formats: ['jpeg', 'png', 'webp', 'avif', 'heic']
    },
    modelGenders: ['female', 'male'],
    garments: taxonomy.GARMENTS.map((g) => ({
      id: g.id,
      name: g.name,
      defaultModelGender: garmentGuide(g.id).wearer,
      designAreas: taxonomy.getDesignTypes(g.id).map((a) => ({ id: a.id, name: a.name }))
    }))
  });
}

module.exports = { generate, cancel, options, PIPELINE };
