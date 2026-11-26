// =============================================================================
// catalogRoutes.js - the WOMEN catalog pipeline.
// =============================================================================
//
// Mounted behind the dispatcher in draping.js as /generate-catalog/women and
// /cancel-job/women.
//
// This is the hardened implementation, not the original extraction: it carries
// the connection-pool limits, admission control, SSE heartbeat and graceful
// shutdown added on satish/disc. The earlier copy of this file predated those
// fixes and also reinstated the /debug-model route, which had been removed.
//
const express = require('express');
const router = express.Router();
const { prisma, close: closeDb } = require('../lib/db');
const aiGenerationService = require('../services/catalogAiService');
const capacity = require('../lib/capacity');
const shared = require('../lib/shared');
const { admitGeneration, cancelGeneration } = require('../middleware/generationGuard');
const { parseColourVariant, colourSummary } = require('../services/colourVariant');
const { publicMessage } = require('../lib/publicError');
const billing = require('../modules/billing/billing.service');
const productShots = require('../services/productShots');
const { stepLog, secondsSince, setContext } = require('../lib/stepLog');

/** A job-status write must never take the stream down with it. */
async function recordJob(jobId, data) {
  if (!jobId) return;
  try {
    await prisma.drapeJob.update({ where: { id: jobId }, data });
  } catch (err) {
    console.error(`[Catalog] could not record job ${jobId} as ${data.status}:`, err.message);
  }
}

// Running jobs, the zombie killer and admission control live in
// middleware/generationGuard.js, shared with the men pipeline and visible to
// every server - a cancel reaches the job wherever it runs.

// How often to emit an SSE comment while a view is generating. Views take
// 14-25s each, and proxies commonly idle-timeout at 30-60s with nothing on the
// wire; a heartbeat keeps the connection demonstrably alive.
const SSE_HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 15000);


// Explicit endpoint to kill jobs since reverse proxies sometimes mask TCP disconnects
router.post('/cancel-job/women', async (req, res) => {
  const clientId = typeof req.body.clientId === 'number' ? String(req.body.clientId) : req.body.clientId;
  if (!clientId || typeof clientId !== 'string') return res.status(400).json({ success: false, error: 'clientId required' });

  if (await cancelGeneration(req, { clientId, pipeline: 'women' })) {
    console.log(`[Zombie Killer] Explicit cancellation received for client ${clientId}.`);
    return res.json({ success: true, message: 'Pipeline successfully aborted.' });
  }

  res.json({ success: false, message: 'No active job running for this client.' });
});

router.post('/generate-catalog/women', async (req, res) => {
  const startTime = Date.now();
  let jobId = null;
  let viewsDelivered = 0;
  let shotsMade = 0;
  let shotsFailed = 0;
  let heartbeat = null;
  let admitted = null;
  // A late product shot must never write to a stream that has already ended.
  const writeEvent = (event) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };

  try {
  const { modelId, bottom } = req.body;
    // A numeric clientId always worked; keep it working, as text.
    const clientId = typeof req.body.clientId === 'number' ? String(req.body.clientId) : req.body.clientId;
    let category = req.body.category || 'SAREE';

    // Hardcoded Dupatta URL Mapping for third-party client convenience
    const DUPATTA_URLS = {
      'lehanga_duppatta1': 'https://gsriztjnocjwgqkaxhhz.supabase.co/storage/v1/object/public/tryon-fits/lehanga_duppatta1.jpg',
      'lehangaduppatta2': 'https://gsriztjnocjwgqkaxhhz.supabase.co/storage/v1/object/public/tryon-fits/lehangaduppatta2.jpg'
    };

    let dupattaStyleUrl = req.body.dupattaStyleUrl;
    if (dupattaStyleUrl && DUPATTA_URLS[dupattaStyleUrl]) {
      dupattaStyleUrl = DUPATTA_URLS[dupattaStyleUrl];
    }
    
    // Support Tryon platform key names (saree, blouse, full, top) or generic keys
    const fullDress = req.body.saree || req.body.full || req.body.fullDress;
    const topFront = req.body.blouse || req.body.top || req.body.topFront;
    const topBack = req.body.topBack;

    // Validate strictly required fields
    if (!clientId || !modelId) {
      return res.status(400).json({ success: false, error: 'clientId and modelId are required.' });
    }
    if (typeof clientId !== 'string' || typeof modelId !== 'string') {
      return res.status(400).json({ success: false, error: 'clientId and modelId must be text.' });
    }

    if (!fullDress) {
      return res.status(400).json({ success: false, error: 'The primary garment image (fullDress / flat-lay) is strictly required.' });
    }

    // Default category to SAREE if not provided
    const safeCategory = (category || 'SAREE').toUpperCase();

    // COLOUR VARIANT (optional): "the same saree, in another colour".
    // `color`, `colour` or `colorVariant`; a name, a hex code, or an object.
    // Refused as a clear 400 before any slot is taken or any call is made.
    let colour = null;
    try {
      // The first one actually filled in: a blank `color: ""` left by a form
      // must not hide a real `colour` sent beside it.
      const filled = (v) => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim());
      const raw = [req.body.color, req.body.colour, req.body.colorVariant].find(filled);
      colour = parseColourVariant(raw);
    } catch (err) {
      if (err.code === 'INVALID_COLOR') return res.status(400).json({ success: false, error: err.message, code: 'INVALID_COLOR' });
      throw err;
    }
    const variant = colourSummary(colour);

    // PRODUCT SHOTS (optional, owner 26 Nov 2026): photos of the saree with no model - folded and a
    // styled table scene - each in a random setting. Sarees only for now.
    const wantShots = req.body.productShots === true || req.body.productShots === 'true';
    if (wantShots && safeCategory !== 'SAREE') {
      return res.status(400).json({ success: false, code: 'PRODUCT_SHOTS_SAREE_ONLY', error: 'productShots is available for sarees only (category "SAREE").' });
    }
    if (wantShots && colour) {
      return res.status(400).json({ success: false, code: 'PRODUCT_SHOTS_NO_COLOUR_VARIANT', error: 'productShots cannot be combined with a colour variant yet. Ask for them on the normal catalog request.' });
    }

    // BILLING: what makes this run "the same request" (the caller's jobId, else
    // the Gateway request id). A jobId that was already delivered and charged
    // is refused here, before any AI work, so reusing one cannot buy a second
    // catalog for free and a retry can never be charged twice.
    let requestKey = null;
    try {
      requestKey = billing.requestKeyFor(req, billing.callerJobId(req.body));
    } catch (err) {
      if (err instanceof billing.BillingInputError) return res.status(400).json({ success: false, error: err.message, code: err.code });
      throw err;
    }
    if (requestKey && requestKey.startsWith('job:') && await billing.findDelivered(req.account, requestKey)) {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_DELIVERED',
        error: 'This jobId was already delivered and charged. Send a new jobId to make another catalog.'
      });
    }
    viewsDelivered = 0;

    // 1. Fetch the exact 4 Base Poses from the Database for this model
    const model = await prisma.aiModel.findUnique({
      where: { id: modelId }
    });

    if (!model) {
      return res.status(404).json({ success: false, error: 'AI Model not found' });
    }

    let finalFrontBaseUrl = model.frontBaseUrl;
    
    // DUPATTA SELECTION OVERRIDE
    if (safeCategory === 'LEHANGA' && dupattaStyleUrl) {
      if (dupattaStyleUrl.includes('lehanga_duppatta1')) {
        let specialFileName = 'front%20single%20pleated%20dupatta.png'; // lehanga1
        if (modelId === 'lehanga2') specialFileName = 'front%20single%20pleated%20duptta.png';
        if (modelId === 'lehanga3') specialFileName = 'front%20single%20pleated%20dupatta%20(2).png';
        if (modelId === 'lehanga4') specialFileName = 'front%20single%20pleated%20dupatta%20(3).png';
        
        const baseUrlPath = model.frontBaseUrl.substring(0, model.frontBaseUrl.lastIndexOf('/'));
        finalFrontBaseUrl = `${baseUrlPath}/${specialFileName}`;
      }
    }

    // --- BUDGET, ZOMBIE KILLER, ADMISSION CONTROL ---
    // Replaces this client's previous job wherever it runs, and refuses with a
    // JSON 429 (never 5xx, never queued) when over budget or at capacity.
    admitted = await admitGeneration(req, res, { clientId, pipeline: 'women' });
    if (!admitted) return;
    const abortController = admitted.job;

    // The caller hung up (gateway timeout, closed tab): stop paying for views
    // nobody will receive. This must be the RESPONSE's close - on Express 5 the
    // request has already finished being read and never reports a hang-up.
    res.on('close', () => {
      if (!res.writableFinished && !abortController.signal.aborted) {
        console.log(`Client connection closed for job ${jobId}. Aborting pipeline...`);
        abortController.abort();
      }
    });

    // 2. Log the Job Start in Prisma (Zero-Retention: We don't save the Base64 images)
    const job = await prisma.drapeJob.create({
      data: {
        clientId: clientId,
        modelId: modelId,
        status: 'PROCESSING'
      }
    });
    jobId = job.id;
    setContext({ jobId, endpoint: 'women' });
    stepLog('Catalog', { jobId, endpoint: 'women', account: req.account, garment: safeCategory, model: modelId, colour: variant ? variant.colorName : null, result: 'started' });
    let lastViewAt = Date.now();

    // --- SSE STREAMING INITIALIZATION ---
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); 

    res.write(`data: ${JSON.stringify({ type: 'STATUS', message: 'Starting AI Generation Pipeline...' })}\n\n`);
    // Says what colour was asked for, and that the result is close to it, not
    // an exact hex match: model-made pixels cannot promise that.
    if (variant) res.write(`data: ${JSON.stringify({ type: 'COLOR_VARIANT', ...variant })}\n\n`);

    // Keep the connection provably alive across the 14-25s gaps between views.
    // An SSE comment line is ignored by every compliant client, so this cannot
    // confuse a consumer that only parses `data:` frames.
    heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`: keepalive ${Date.now()}

`);
    }, SSE_HEARTBEAT_MS);

    // 3. Initiate the Generation Service Flow
   const generatedViews = await aiGenerationService.generate4ViewCatalog(
  {
    fullDress,
    topFront,
    topBack,
    bottom,
    category: safeCategory,
    dupattaStyleUrl,
    colour,
    afterFront: wantShots
      ? (front, refs) => {
          writeEvent({ type: 'STATUS', message: `Making ${productShots.SHOT_COUNT} product shots beside the views...` });
          return productShots.makeProductShots({ ...refs, front }, {
            generate: aiGenerationService.callGeminiImageGen,
            signal: abortController.signal,
            onShot: (shot) => {
              if (shot.image) shotsMade += 1; else shotsFailed += 1;
              writeEvent({ type: 'PRODUCT_SHOT', ...shot });
            }
          });
        }
      : null
  },
      {
        // No back view (29 Oct): the model's back pose is kept in the database, never drawn.
        front: finalFrontBaseUrl,
        side: model.sideBaseUrl,
        sitting: model.sittingBaseUrl
      },
      (progressEvent) => {
        // A step has started (the recolour pass) - or a view has finished.
        if (progressEvent.type === 'status') {
          res.write(`data: ${JSON.stringify({ type: 'STATUS', message: progressEvent.message })}\n\n`);
          return;
        }
        // Fire events back to the client the millisecond a view finishes!
        res.write(`data: ${JSON.stringify({ type: 'VIEW_READY', ...progressEvent })}\n\n`);
        viewsDelivered += 1;
        stepLog('Catalog', { jobId, endpoint: 'women', garment: safeCategory, item: progressEvent.view, result: 'made', seconds: secondsSince(lastViewAt) });
        lastViewAt = Date.now();
      },
      abortController.signal
    );

    // 4. Update Job Status to COMPLETED
    await recordJob(jobId, { status: 'COMPLETED', latencyMs: Date.now() - startTime });

    // 4b. Charge it: one row, only for a full delivery, only once. Never throws.
    await billing.recordDeliveredRun({
      clientId: req.account,
      requestKey,
      colour,
      garment: fullDress,
      views: viewsDelivered,
      drapeJobId: jobId,
      gatewayRequestId: billing.gatewayRequestId(req)
    });

    // 5. Close stream
    res.write(`data: ${JSON.stringify({
      type: 'COMPLETE',
      jobId: jobId,
      ...(variant ? { colorVariant: variant } : {}),
      ...(wantShots ? { productShots: { made: shotsMade, failed: shotsFailed } } : {})
    })}\n\n`);
    res.end();
    stepLog('Catalog', { jobId, endpoint: 'women', garment: safeCategory, result: 'complete', views: viewsDelivered, shots: wantShots ? `${shotsMade} of ${productShots.SHOT_COUNT}` : null, seconds: secondsSince(startTime) });

  } catch (error) {
    const open = res.headersSent && !res.writableEnded && !res.destroyed;
    const message = String((error && error.message) || error);
    if ((error && error.name === 'AbortError') || message.includes('AbortError')) {
      stepLog('Catalog', { jobId, endpoint: 'women', result: 'cancelled', views: viewsDelivered, seconds: secondsSince(startTime), why: 'replaced by a newer job or the caller hung up' });
      await recordJob(jobId, { status: 'CANCELLED', latencyMs: Date.now() - startTime });
      // Replaced by a newer job or cancelled from elsewhere while the caller is
      // still listening: say so, so the caller does not read the end of the
      // stream as a finished catalog.
      if (open) {
        res.write(`data: ${JSON.stringify({ type: 'ERROR', code: 'CANCELLED', error: 'Generation was cancelled.' })}\n\n`);
        res.end();
      }
      return;
    }

    console.error(`[Catalog] job ${jobId} failed:`, message);
    stepLog('Catalog', { jobId, endpoint: 'women', result: 'failed', views: viewsDelivered, seconds: secondsSince(startTime), code: error && error.code });
    await recordJob(jobId, { status: 'FAILED', errorMessage: message.slice(0, 1000), latencyMs: Date.now() - startTime });

    const error_ = publicMessage(error);
    if (open) {
      res.write(`data: ${JSON.stringify({ type: 'ERROR', code: (error.expose && error.code) || 'GENERATION_FAILED', error: error_ })}\n\n`);
      res.end();
    } else if (!res.headersSent) {
      res.status(500).json({ success: false, error: error_ });
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    // Frees the slot and removes the job from the shared list. Only this job's
    // own entry is touched, so a newer job for the same client is unaffected.
    if (admitted) await admitted.release();
  }
});

/** Called from src/index.js on SIGTERM/SIGINT so connections are released. */
async function shutdown() {
  await shared.stop();
  await closeDb();
}

module.exports = router;
module.exports.shutdown = shutdown;
module.exports.stats = () => ({ ...capacity.stats(), pools: capacity.allStats(), ...shared.jobs.stats() });
