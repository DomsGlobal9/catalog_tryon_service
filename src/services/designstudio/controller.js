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
const { buildPrompt, referenceList, pairing, DEFAULT_PAIRING_COLOUR } = require('./promptBuilder');
const { describeReferences } = require('./describeReferences');
const { locateParts, cropReferences } = require('./cropReferences');
const { generateImage } = require('./geminiImage');
const { reviewImage, correctionsText } = require('./qualityCheck');
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
    const out = config.stream.detail === 'full' ? event : imageOnly(event);
    if (out) res.write(`data: ${JSON.stringify(out)}\n\n`);
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
      // What the model wears with the product, so the caller can see the blouse
      // (or saree) colour that was decided without having to guess.
      pairedWith: (() => {
        const pair = pairing(job);
        return pair ? { pieces: pair.pieces, colour: pair.colour, from: pair.from, note: pair.note } : null;
      })(),
      model: job.model.kind,
      pose: prompt.pose,
      framing: prompt.framing, // full | three-quarter | waist-up
      aspectRatio: config.gemini.aspectRatio,
      warnings: prompt.warnings
    });

    // Step one: put the references into words, so the image model cannot quietly
    // simplify a temple border into plain bands. Optional and never fatal.
    let descriptions = new Map();
    let boxes = new Map();
    if (config.describe.enabled) {
      send({ type: 'status', stage: 'reading-references', message: 'Reading the designs and fabrics.' });
      const describeStarted = Date.now();
      // The part each design is for is found at the same time, so it costs no wait.
      [descriptions, boxes] = await Promise.all([
        describeReferences(referenceList(job), { signal: abort.signal }),
        locateParts(job, { signal: abort.signal })
      ]);
      job.describeMs = Date.now() - describeStarted;
      // Show the image model only the part each design reference is for.
      const crops = await cropReferences(job, boxes);
      if (crops.length) console.log(`[DesignStudio] requestId=${requestId} cropped to the part: ${crops.map((c) => `${c.area} ${c.from}->${c.to}`).join(', ')}`);
      if (descriptions.size || crops.length) {
        const before = prompt.warnings;
        prompt = buildPrompt(job, { descriptions });
        send({
          type: 'brief',
          jobId: admitted.job.id,
          references: [...descriptions.entries()].map(([ref, info]) => ({ ref, ...info })),
          // Only what reading the references revealed; start already carried the rest.
          warnings: prompt.warnings.filter((w) => !before.includes(w))
        });
      }
    }

    const generationStarted = Date.now();
    const generate = (parts, label) => generateImage(parts, {
      signal: abort.signal,
      onAttempt: ({ attempt, reason }) => send({
        type: 'status',
        stage: label,
        attempt,
        message: attempt === 1
          ? (label === 'regenerating' ? 'Regenerating with the inspector\'s corrections.' : 'Generating the garment.')
          : `Retrying (${reason === 'no_image' ? 'no image was returned' : 'the image model was busy'}).`
      })
    });
    let result = await generate(prompt.parts, 'generating');
    attempts = result.attempts;
    usage = result.usage;

    // Step three: inspect the photograph, and regenerate once with any fault named.
    const quality = { checked: false, passed: null, regenerated: false, failures: [] };
    if (config.qa.enabled && prompt.review) {
      send({ type: 'status', stage: 'checking', message: 'Inspecting the photograph.' });
      let verdict = await reviewImage(prompt.review, result.image, { signal: abort.signal });
      let regenerations = 0;
      while (verdict.checked && verdict.failures.length
        && regenerations < config.qa.maxRegenerations
        && Date.now() - startedAt < config.qa.regenerateIfElapsedUnderMs) {
        regenerations++;
        console.log(`[DesignStudio] requestId=${requestId} inspection failed: ${verdict.failures.map((f) => `${f.id} (${f.evidence})`).join('; ')} - regenerating`);
        // Measured: a NECK photo of a kurta sequinned all over kept sequinning the new
        // kurta through the rules and a correction. When decoration spread beyond the
        // designed parts, the retry is shown tighter crops of the references.
        let retryParts = prompt.parts;
        if (verdict.failures.some((f) => f.id === 'plain_rest' || f.id === 'plain_sleeves') && boxes.size) {
          const tight = await cropReferences(job, boxes, { tight: true });
          if (tight.length) {
            retryParts = buildPrompt(job, { descriptions }).parts;
            console.log(`[DesignStudio] requestId=${requestId} retry uses tighter crops: ${tight.map((c) => `${c.area} ${c.from}->${c.to}`).join(', ')}`);
          }
        }
        let retry;
        try {
          retry = await generate([...retryParts, { text: correctionsText(verdict.failures) }], 'regenerating');
        } catch (err) {
          if (err instanceof StudioError && err.code === 'CANCELLED') throw err;
          break; // keep the first photograph rather than fail the request
        }
        attempts += retry.attempts;
        quality.regenerated = true;
        send({ type: 'status', stage: 'checking', message: 'Inspecting the corrected photograph.' });
        const second = await reviewImage(prompt.review, retry.image, { signal: abort.signal });
        // Keep the corrected photograph unless the inspection shows it is worse.
        // If the second inspection could not run, the corrected photograph is
        // kept but reported unchecked - its faults are not known.
        if (!second.checked || second.failures.length <= verdict.failures.length) {
          result = retry;
          usage = retry.usage;
          verdict = second;
        }
      }
      quality.checked = verdict.checked;
      quality.passed = verdict.checked ? verdict.failures.length === 0 : null;
      quality.failures = verdict.failures.map((f) => ({ check: f.id, evidence: f.evidence }));
    }

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
      quality,
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

/**
 * The caller's view of an event by default: the photograph and only what is
 * needed to receive it. The jobId stays so a generation can be cancelled; an
 * error keeps its code, message and retryable flag. Everything else (the reading
 * of the references, warnings, progress text, inspection, timings) is dropped.
 */
function imageOnly(event) {
  switch (event.type) {
    case 'start': return { type: 'start', jobId: event.jobId };
    case 'image': return { type: 'image', jobId: event.jobId, mimeType: event.mimeType, width: event.width, height: event.height, image: event.image };
    case 'done': return { type: 'done', jobId: event.jobId, status: event.status };
    case 'error': return { type: 'error', jobId: event.jobId, code: event.code, message: event.message, retryable: event.retryable };
    default: return null; // status, brief
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
      // How much of the model is in the photo, so the product fills the frame.
      framing: garmentGuide(g.id).framing,
      // The supporting pieces worn with this product (never designed), or null
      // when the product is the whole outfit. Set their colour with pairWith.
      pairedWith: garmentGuide(g.id).pairedWith
        ? { pieces: garmentGuide(g.id).pairedWith.pieces, defaultColour: DEFAULT_PAIRING_COLOUR[garmentGuide(g.id).pairedWith.colour] }
        : null,
      designAreas: taxonomy.getDesignTypes(g.id).map((a) => ({ id: a.id, name: a.name }))
    }))
  });
}

module.exports = { generate, cancel, options, PIPELINE };
