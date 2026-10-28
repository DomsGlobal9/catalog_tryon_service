// =============================================================================
// sketchController.js — POST /sketch, start to finish (since 28 Oct 2026).
// =============================================================================
//
// The same shape as POST /generate (controller.js), and the same plumbing:
//   before the stream: validate (400), download and check the pictures (422),
//   admit (429). One job per client across BOTH endpoints (same pipeline name),
//   cancelled by POST /cancel, collected by GET /result/:jobId.
//   the stream: start -> reading (what the drawing says) -> per view: the photo,
//   checked against the sketch and redone once -> done. Or `error`.
//
const crypto = require('crypto');
const { config } = require('./config');
const { StudioError, redact } = require('./errors');
const { prepareImages } = require('./imageInput');
const { generateImage } = require('./geminiImage');
const { correctionsText } = require('./qualityCheck');
const { garmentGuide, taxonomy } = require('./garmentGuide');
const { framePerson, makeDresser } = require('./drapeOnPerson');
const { resolveSketchRequest, readSketch, mergeLabels, buildSketchPrompt, reviewSketchPhoto } = require('./sketch');
const resultStore = require('./resultStore');
const { imageOnly, logOutcome, PIPELINE } = require('./controller');
const { admitGeneration } = require('../../middleware/generationGuard');

async function sketch(req, res, next) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const abort = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) abort.abort(); });

  let job;
  let prepared;
  let admitted;
  try {
    job = resolveSketchRequest(req.body);
    const prepStarted = Date.now();
    prepared = await prepareImages(job, abort.signal);
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

  resultStore.begin(admitted.job.id, req.account);
  const send = (event) => {
    const out = config.stream.detail === 'full' ? event : imageOnly(event);
    resultStore.record(admitted.job.id, out);
    if (res.writableEnded || res.destroyed) return;
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
    send({ type: 'start', requestId, jobId: admitted.job.id, endpoint: 'sketch', presentation: job.presentation, model: job.model.kind, garment: job.garmentId, warnings: [...job.inputWarnings] });

    // Step one: read the drawing.
    send({ type: 'status', stage: 'reading-sketch', message: 'Reading the sketch and its labels.' });
    const readStarted = Date.now();
    const { reading, problem } = await readSketch(job, { signal: abort.signal });
    job.describeMs = Date.now() - readStarted;
    if (!reading) {
      console.warn(`[DesignStudio] requestId=${requestId} sketch not read: ${problem}`);
      throw new StudioError('The sketch could not be read just now. Please try again in a moment.', { status: 424, code: 'SKETCH_NOT_READ', retryable: true });
    }
    if (!reading.isSketch) {
      throw new StudioError('This picture does not look like a drawing of a garment. Send the hand-drawn sketch with its labels.', { status: 422, code: 'NOT_A_SKETCH' });
    }
    const warnings = [];
    if (job.garmentId && reading.garmentId && reading.garmentId !== job.garmentId) {
      warnings.push(`You sent garment ${job.garmentId}; the sketch looks like ${reading.garmentId}. It is made as ${job.garmentId}.`);
    }
    if (!job.garmentId) {
      if (!reading.garmentId) {
        throw new StudioError(`The sketch did not show which garment it is. Send garment as well, one of: ${taxonomy.GARMENT_IDS.join(', ')}.`, { status: 422, code: 'GARMENT_UNKNOWN' });
      }
      job.garmentId = reading.garmentId;
      job.garmentName = taxonomy.getGarment(reading.garmentId).name;
      if (job.model.kind === 'generated' && !job.model.gender) job.model.gender = garmentGuide(job.garmentId).wearer;
    }
    const g = garmentGuide(job.garmentId);
    const sides = g.sides || ['front'];
    const backWanted = reading.views.back || job.sketches.some((s) => s.view === 'back');
    const views = backWanted && sides.includes('back') ? ['front', 'back'] : ['front'];
    if (backWanted && !sides.includes('back')) warnings.push(`A ${g.product} is photographed from the front only; the back drawing was not used.`);
    const parts = mergeLabels(reading.parts, job.labels);
    if (reading.unreadable.length) warnings.push(`Could not read on the sketch: ${reading.unreadable.map((u) => `"${u}"`).join(', ')}. Send the right words in labels to use them.`);
    if (!parts.length && !job.fabrics.length) warnings.push('No colours were written on the sketch and no fabric was sent, so the colours are chosen for you.');
    send({
      type: 'reading',
      jobId: admitted.job.id,
      garment: job.garmentId,
      views,
      silhouette: reading.silhouette,
      parts: parts.map(({ label, part, color, colorHex, material, work, from }) => ({ label, part, color, colorHex, material, work, from })),
      notes: reading.notes,
      unreadable: reading.unreadable,
      warnings
    });

    const generationStarted = Date.now();
    const generate = (genParts, label, { imageSize, aspectRatio } = {}) => generateImage(genParts, {
      signal: abort.signal,
      imageSize: imageSize || config.gemini.imageSize,
      aspectRatio,
      onAttempt: ({ attempt, reason }) => send({
        type: 'status',
        stage: label,
        attempt,
        message: attempt === 1
          ? (label === 'regenerating' ? 'Regenerating with the inspector\'s corrections.' : label === 'draping' ? 'Dressing the photo.' : 'Making the garment from the sketch.')
          : `Retrying (${reason === 'no_image' ? 'no image was returned' : 'the image model was busy'}).`
      })
    });

    // Step three, per photo: checked against the sketch, made once more with the faults named.
    const check = async (prompt, result, quality) => {
      if (!config.pair.enabled) return result;
      send({ type: 'status', stage: 'checking', message: 'Comparing the photograph with the sketch.' });
      let verdict = await reviewSketchPhoto(prompt.review, result.image, { signal: abort.signal });
      if (verdict.checked && verdict.failures.length && config.pair.maxRegenerations > 0
        && Date.now() - startedAt < config.qa.regenerateIfElapsedUnderMs) {
        console.log(`[DesignStudio] requestId=${requestId} sketch ${prompt.review.view}: ${verdict.failures.map((f) => `${f.id} (${f.evidence})`).join('; ')} - regenerating`);
        try {
          const retry = await generate([...prompt.parts, { text: correctionsText(verdict.failures) }], 'regenerating');
          attempts += retry.attempts;
          quality.regenerated = true;
          send({ type: 'status', stage: 'checking', message: 'Checking the corrected photograph.' });
          const second = await reviewSketchPhoto(prompt.review, retry.image, { signal: abort.signal });
          if (!second.checked || second.failures.length <= verdict.failures.length) { result = retry; usage = retry.usage; verdict = second; }
        } catch (err) {
          if (err instanceof StudioError && err.code === 'CANCELLED') throw err;
        }
      }
      quality.sketch = { checked: verdict.checked, passed: verdict.checked ? verdict.failures.length === 0 : null, failures: verdict.failures.map((f) => ({ check: f.id, evidence: f.evidence })) };
      return result;
    };

    // The caller's own photo: the garment on a mannequin first, then dressed onto the photo.
    const ownPhoto = job.model.kind === 'reference';
    const garmentPresentation = ownPhoto ? 'mannequin' : job.presentation;
    const framed = ownPhoto ? await framePerson(job.model.image) : null;
    const dress = ownPhoto ? makeDresser({ job, framed, generate, send, signal: abort.signal, startedAt, requestId, count: (out) => { attempts += out.attempts; } }) : null;

    const results = [];
    let frontGarment = null;
    for (const view of views) {
      const prompt = buildSketchPrompt(job, { reading, parts, view, frontPhoto: view === 'back' && frontGarment ? frontGarment.image : null, presentation: garmentPresentation });
      send({ type: 'status', stage: 'generating', view, message: ownPhoto ? `Making the ${view} of the garment.` : `Making the ${view} view from the sketch.` });
      let result = await generate(prompt.parts, 'generating');
      attempts += result.attempts;
      usage = result.usage;
      const quality = { regenerated: false };
      result = await check(prompt, result, quality);
      if (view === 'front') frontGarment = result;
      if (ownPhoto) {
        result = await dress(view, { product: g.product, garmentId: job.garmentId }, result, quality);
        usage = result.usage;
      }
      results.push({ view, quality });
      send({
        type: 'image',
        jobId: admitted.job.id,
        view,
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
      views,
      attempts,
      quality: results.length === 1 ? results[0].quality : Object.fromEntries(results.map((r) => [r.view, r.quality])),
      timings: { prepareMs: job.prepareMs, readMs: job.describeMs || 0, generateMs: Date.now() - generationStarted, totalMs: Date.now() - startedAt }
    });
    outcome = 'OK';
  } catch (err) {
    if ((err instanceof StudioError && err.code === 'CANCELLED') || abort.signal.aborted) {
      outcome = 'CANCELLED';
      send({ type: 'error', jobId: admitted.job.id, code: 'CANCELLED', message: 'Generation was cancelled.', retryable: false });
    } else if (err instanceof StudioError) {
      outcome = err.code;
      send({ type: 'error', jobId: admitted.job.id, ...err.toJSON() });
    } else {
      outcome = 'INTERNAL_ERROR';
      console.error(`[DesignStudio] requestId=${requestId} sketch crashed:`, redact(err && err.stack ? err.stack : err));
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

module.exports = { sketch };
