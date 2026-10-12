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
const { resolveRequest, PRESENTATIONS } = require('./validate');
const { prepareImages } = require('./imageInput');
const { buildPrompt, referenceList, pairing, viewOf, DEFAULT_PAIRING_COLOUR } = require('./promptBuilder');
const { describeReferences } = require('./describeReferences');
const { locateParts, cropReferences } = require('./cropReferences');
const { generateImage } = require('./geminiImage');
const { reviewImage, reviewView, correctionsText } = require('./qualityCheck');
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
  // A cancel that landed while the job was being listed has already fired; a
  // listener added now would never hear it, and the job would run unstoppable.
  if (admitted.job.signal.aborted) abort.abort();

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
      presentation: job.presentation,
      pose: prompt.pose,
      views: job.views || [prompt.pose], // the photographs this request will make, in order
      framing: prompt.framing, // full | three-quarter | waist-up
      aspectRatio: config.gemini.aspectRatio,
      warnings: prompt.warnings
    });

    // Step one: put the references into words, so the image model cannot quietly
    // simplify a temple border into plain bands. Optional and never fatal.
    let descriptions = new Map();
    let boxes = new Map();
    // Cropping has its own switch: it used to run only when describing was on.
    // A sketch draws the back figure in the same call as the front, so nothing checks it against a
    // finished front. Measured (12 Oct 2026): a whole-gown BACK picture put its leaves and colour on
    // the back of the skirt. So a sketch's BACK design is cropped to that part even with cropping off.
    const forcedCrops = !config.crop.enabled && job.presentation === 'sketch' && job.designs.some((d) => d.areaId === 'BACK') ? ['BACK'] : null;
    if (config.describe.enabled || config.crop.enabled || forcedCrops) {
      send({ type: 'status', stage: 'reading-references', message: 'Reading the designs and fabrics.' });
      const describeStarted = Date.now();
      // The part each design is for is found at the same time, so it costs no wait.
      [descriptions, boxes] = await Promise.all([
        config.describe.enabled ? describeReferences(referenceList(job), { signal: abort.signal }) : new Map(),
        locateParts(job, { signal: abort.signal, only: forcedCrops })
      ]);
      job.describeMs = Date.now() - describeStarted;
      // Show the image model only the part each design reference is for.
      const crops = await cropReferences(job, boxes, { only: forcedCrops });
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

    // Step three, per photograph: inspect it and regenerate once with any fault named.
    const inspect = async (viewPrompt, viewJob, viewDescriptions, result) => {
      const quality = { checked: false, passed: null, regenerated: false, failures: [] };
      if (!(config.qa.enabled && viewPrompt.review)) return { result, quality };
      send({ type: 'status', stage: 'checking', message: 'Inspecting the photograph.' });
      let verdict = await reviewImage(viewPrompt.review, result.image, { signal: abort.signal });
      let regenerations = 0;
      while (verdict.checked && verdict.failures.length
        && regenerations < config.qa.maxRegenerations
        && Date.now() - startedAt < config.qa.regenerateIfElapsedUnderMs) {
        regenerations++;
        console.log(`[DesignStudio] requestId=${requestId} inspection failed: ${verdict.failures.map((f) => `${f.id} (${f.evidence})`).join('; ')} - regenerating`);
        // Measured: a NECK photo of a kurta sequinned all over kept sequinning the new
        // kurta through the rules and a correction. When decoration spread beyond the
        // designed parts, the retry is shown tighter crops of the references.
        let retryParts = viewPrompt.parts;
        let tightened = false;
        if (verdict.failures.some((f) => f.id === 'plain_rest' || f.id === 'plain_sleeves') && boxes.size) {
          const tight = await cropReferences(job, boxes, { tight: true });
          if (tight.length) {
            tightened = true;
            retryParts = buildPrompt(viewJob, { descriptions: viewDescriptions, view: viewPrompt.review.view, frontPhoto: viewPrompt.frontPhoto }).parts;
            console.log(`[DesignStudio] requestId=${requestId} retry uses tighter crops: ${tight.map((c) => `${c.area} ${c.from}->${c.to}`).join(', ')}`);
          }
        }
        let retry;
        try {
          retry = await generate([...retryParts, { text: correctionsText(verdict.failures) }], 'regenerating');
        } catch (err) {
          if (err instanceof StudioError && err.code === 'CANCELLED') throw err;
          break; // keep the first photograph rather than fail the request
        } finally {
          // The tight crops were for this one retry. The back view and the
          // reference comparison that follow use the normal crops again.
          if (tightened) await cropReferences(job, boxes);
        }
        attempts += retry.attempts;
        quality.regenerated = true;
        send({ type: 'status', stage: 'checking', message: 'Inspecting the corrected photograph.' });
        const second = await reviewImage(viewPrompt.review, retry.image, { signal: abort.signal });
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
      return { result, quality };
    };

    // Every photograph is checked against the design references it was made from
    // (neckline shape and depth, motifs, sheer panels, sleeves); a back view is also
    // checked against the front photograph. A mismatch is named and the photograph
    // is made once more.
    const matchReferences = async (viewPrompt, viewJob, viewDescriptions, front, back, quality) => {
      if (!(config.pair.enabled && viewPrompt.review)) return back;
      const references = viewJob.designs
        .map((d, i) => ({ area: d.areaId, ref: i + 1, image: d.image, part: (viewPrompt.review.parts.find((p) => p.area === d.areaId) || {}).part || d.areaId.toLowerCase() }))
        .filter((r) => r.image && r.image.base64);
      const view = viewPrompt.review.view;
      send({ type: 'status', stage: 'checking', message: view === 'back' ? 'Comparing the back view with its references and the front view.' : 'Comparing the photograph with its references.' });
      let verdict = await reviewView(viewPrompt.review, { image: back.image, frontImage: view === 'back' ? front && front.image : null, references, signal: abort.signal });
      let regenerations = 0;
      // Same time guard as the inspection: a correction is only made while the
      // whole request can still finish in time.
      while (verdict.checked && verdict.failures.length && regenerations < config.pair.maxRegenerations
        && Date.now() - startedAt < config.qa.regenerateIfElapsedUnderMs) {
        regenerations++;
        console.log(`[DesignStudio] requestId=${requestId} ${view || 'front'} view does not match: ${verdict.failures.map((f) => `${f.id} (${f.evidence})`).join('; ')} - regenerating`);
        let retry;
        try {
          retry = await generate([...viewPrompt.parts, { text: correctionsText(verdict.failures) }], 'regenerating');
        } catch (err) {
          if (err instanceof StudioError && err.code === 'CANCELLED') throw err;
          break;
        }
        attempts += retry.attempts;
        quality.regenerated = true;
        send({ type: 'status', stage: 'checking', message: 'Checking the corrected photograph.' });
        const second = await reviewView(viewPrompt.review, { image: retry.image, frontImage: view === 'back' ? front && front.image : null, references, signal: abort.signal });
        if (!second.checked || second.failures.length <= verdict.failures.length) { back = retry; usage = retry.usage; verdict = second; }
      }
      quality.references = { checked: verdict.checked, passed: verdict.checked ? verdict.failures.length === 0 : null, failures: verdict.failures.map((f) => ({ check: f.id, evidence: f.evidence })) };
      quality.pair = quality.references; // the older name
      return back;
    };

    // Which photographs to make. A two-sided garment gives front then back;
    // everything else gives one photograph (turned around only for a BACK design).
    // A sketch is ONE sheet with the front and back figures on it: one image, one call.
    const isSketch = job.presentation === 'sketch';
    const views = isSketch ? [null] : (job.views || [null]);
    const results = [];
    let frontResult = null;
    for (const view of views) {
      const { job: viewJob, descriptions: viewDescriptions } = view ? viewOf(job, descriptions, view) : { job, descriptions };
      const viewPrompt = view ? buildPrompt(viewJob, { descriptions: viewDescriptions, view, frontPhoto: view === 'back' && frontResult ? frontResult.image : null }) : prompt;
      if (view === 'back' && frontResult) viewPrompt.frontPhoto = frontResult.image;
      if (view) send({ type: 'status', stage: 'generating', view, message: `Generating the ${view} view.` });
      let result = await generate(viewPrompt.parts, 'generating');
      attempts += result.attempts;
      usage = result.usage;
      let quality;
      ({ result, quality } = await inspect(viewPrompt, viewJob, viewDescriptions, result));
      if (view) result = await matchReferences(viewPrompt, viewJob, viewDescriptions, frontResult, result, quality);
      if (view === 'front') frontResult = result;
      results.push({ view: isSketch ? 'sheet' : view || viewPrompt.pose, result, quality });
      send({
        type: 'image',
        jobId: admitted.job.id,
        view: isSketch ? 'sheet' : view || viewPrompt.pose,
        // The sheet's figures and the exact words of its labels, usable as text.
        ...(isSketch ? { views: job.views, annotations: (viewPrompt.annotations || []).map(({ part, label, on }) => ({ part, label, on })) } : {}),
        mimeType: result.image.mimeType,
        width: result.image.width,
        height: result.image.height,
        bytes: result.image.bytes,
        image: `data:${result.image.mimeType};base64,${result.image.base64}`
      });
    }
    send({
      type: 'done',
      jobId: admitted.job.id,
      status: 'ok',
      presentation: job.presentation,
      views: isSketch ? job.views : results.map((r) => r.view),
      attempts,
      quality: results.length === 1 ? results[0].quality : Object.fromEntries(results.map((r) => [r.view, r.quality])),
      timings: { prepareMs: job.prepareMs, describeMs: job.describeMs || 0, generateMs: Date.now() - generationStarted, totalMs: Date.now() - startedAt }
    });
    outcome = 'OK';
  } catch (err) {
    // A cancel can surface as any error from whatever was running (a check, a
    // crop, a download); while the job is cancelled, it is reported as one.
    if ((err instanceof StudioError && err.code === 'CANCELLED') || abort.signal.aborted) {
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
    // presentation is named only when it is not the default, so a model request's stream is unchanged.
    case 'start': return { type: 'start', jobId: event.jobId, ...(event.presentation && event.presentation !== 'model' ? { presentation: event.presentation } : {}) };
    case 'image': return { type: 'image', jobId: event.jobId, view: event.view, ...(event.annotations ? { views: event.views, annotations: event.annotations } : {}), mimeType: event.mimeType, width: event.width, height: event.height, image: event.image };
    case 'done': return { type: 'done', jobId: event.jobId, status: event.status, ...(event.presentation && event.presentation !== 'model' ? { presentation: event.presentation } : {}), views: event.views };
    // details carries what the docs promise (GENERATION_BLOCKED's reason, which
    // image failed) - written for the caller, never upstream text.
    case 'error': return { type: 'error', jobId: event.jobId, code: event.code, message: event.message, retryable: event.retryable, ...(event.details ? { details: event.details } : {}) };
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
    // How the garment is shown: on a person (default), on a dress-form mannequin, or as one sketch sheet.
    presentations: PRESENTATIONS,
    garments: taxonomy.GARMENTS.map((g) => ({
      id: g.id,
      name: g.name,
      defaultModelGender: garmentGuide(g.id).wearer,
      // How much of the model is in the photo, so the product fills the frame.
      framing: garmentGuide(g.id).framing,
      // The photographs made by default: ['front'] or ['front', 'back']. Choose with `views`.
      views: garmentGuide(g.id).sides || ['front'],
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
