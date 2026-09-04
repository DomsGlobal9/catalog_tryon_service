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
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');
const aiGenerationService = require('../services/catalogAiService');

// Global registry to track active jobs per client to kill zombies on page refresh
const activeClientJobs = new Map();

// A single generation holds four base models plus the garment images through
// sharp, and four ~740KB base64 outputs simultaneously. Unbounded concurrency
// exhausts memory on a small instance long before it saturates the CPU, so
// admission is capped and excess load is rejected rather than queued - a caller
// gets a fast, honest 429 instead of a request that silently starves.
const MAX_CONCURRENT_GENERATIONS = Number(process.env.MAX_CONCURRENT_GENERATIONS || 3);
let activeGenerations = 0;

// How often to emit an SSE comment while a view is generating. Views take
// 14-25s each, and proxies commonly idle-timeout at 30-60s with nothing on the
// wire; a heartbeat keeps the connection demonstrably alive.
const SSE_HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS || 15000);

// Explicit pool limits. The default (max 10, no timeouts) lets a slow database
// hold connections open indefinitely and gives no signal when the pool is
// exhausted - the request simply hangs.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_MS || 30000),
  connectionTimeoutMillis: Number(process.env.DB_POOL_CONNECT_MS || 10000)
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Explicit endpoint to kill jobs since reverse proxies sometimes mask TCP disconnects
router.post('/cancel-job/women', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ success: false, error: 'clientId required' });

  if (activeClientJobs.has(clientId)) {
    console.log(`[Zombie Killer] Explicit cancellation received from frontend for client ${clientId}. Assasinating pipeline...`);
    const oldController = activeClientJobs.get(clientId);
    oldController.abort();
    activeClientJobs.delete(clientId);
    return res.json({ success: true, message: 'Pipeline successfully aborted.' });
  }
  
  res.json({ success: false, message: 'No active job running for this client.' });
});

router.post('/generate-catalog/women', async (req, res) => {
  const startTime = Date.now();
  let jobId = null;
  let abortController = null;
  let heartbeat = null;
  let slotTaken = false;

  try {
  const { clientId, modelId, bottom } = req.body;
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

    if (!fullDress) {
      return res.status(400).json({ success: false, error: 'The primary garment image (fullDress / flat-lay) is strictly required.' });
    }

    // Default category to SAREE if not provided
    const safeCategory = (category || 'SAREE').toUpperCase();

    // 1. Fetch the exact 4 Base Poses from the Database for this model
    const model = await prisma.aiModel.findUnique({
      where: { id: modelId }
    });
    console.log('===== MODEL SELECTED =====');
console.log('modelId:', modelId);
console.log('frontBaseUrl:', model?.frontBaseUrl);
console.log('backBaseUrl:', model?.backBaseUrl);
console.log('sideBaseUrl:', model?.sideBaseUrl);
console.log('sittingBaseUrl:', model?.sittingBaseUrl);
console.log('==========================');

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
        console.log("DUPATTA OVERRIDE: Using special front image:", finalFrontBaseUrl);
      }
    }

    // --- ZOMBIE PROCESS KILLER ---
    // If this client already has a generation running (e.g. they hit refresh and clicked generate again),
    // instantly kill their old running pipeline to save GPU compute and prevent 503 pileups.
    if (activeClientJobs.has(clientId)) {
      console.log(`[Zombie Killer] Client ${clientId} started a new job. Killing previous zombie job...`);
      const oldController = activeClientJobs.get(clientId);
      oldController.abort();
      activeClientJobs.delete(clientId);
    }

    // --- ADMISSION CONTROL ---
    // Rejected, not queued: a caller learns immediately rather than waiting on a
    // request that will starve. 429 is deliberate - it is 4xx, so a busy service
    // cannot trip the gateway's per-slug circuit breaker and take discovery down.
    if (activeGenerations >= MAX_CONCURRENT_GENERATIONS) {
      console.warn(`[Capacity] Rejecting generation for ${clientId}: ${activeGenerations}/${MAX_CONCURRENT_GENERATIONS} slots in use.`);
      return res.status(429).json({
        success: false,
        error: 'Service at capacity. Please retry shortly.',
        activeGenerations,
        maxConcurrent: MAX_CONCURRENT_GENERATIONS
      });
    }
    activeGenerations += 1;
    slotTaken = true;

    // 2. Log the Job Start in Prisma (Zero-Retention: We don't save the Base64 images)
    const job = await prisma.drapeJob.create({
      data: {
        clientId: clientId,
        modelId: modelId,
        status: 'PROCESSING'
      }
    });
    jobId = job.id;

    abortController = new AbortController();
    activeClientJobs.set(clientId, abortController);

    req.on('close', () => {
      console.log(`Client connection closed for job ${jobId}. Aborting pipeline...`);
      abortController.abort();
    });

    // --- SSE STREAMING INITIALIZATION ---
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); 

    res.write(`data: ${JSON.stringify({ type: 'STATUS', message: 'Starting AI Generation Pipeline...' })}\n\n`);

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
    dupattaStyleUrl
  },
      {
        front: finalFrontBaseUrl,
        back: model.backBaseUrl,
        side: model.sideBaseUrl,
        sitting: model.sittingBaseUrl
      },
      (progressEvent) => {
        // Fire events back to the client the millisecond a view finishes!
        res.write(`data: ${JSON.stringify({ type: 'VIEW_READY', ...progressEvent })}\n\n`);
      },
      abortController.signal
    );

    // 4. Update Job Status to COMPLETED
    await prisma.drapeJob.update({
      where: { id: jobId },
      data: { 
        status: 'COMPLETED',
        latencyMs: Date.now() - startTime
      }
    });

    // 5. Close stream
    res.write(`data: ${JSON.stringify({ type: 'COMPLETE', jobId: jobId })}\n\n`);
    res.end();

  } catch (error) {
    if (error.name === 'AbortError' || error.message.includes('AbortError')) {
      console.log(`Job ${jobId} was aborted (Likely due to Zombie Killer or client disconnect).`);
      if (jobId) {
        await prisma.drapeJob.update({
          where: { id: jobId },
          data: { status: 'CANCELLED', latencyMs: Date.now() - startTime }
        });
      }
      return; // Connection is already closed or superseded, do not write to res
    }

    if (jobId) {
      await prisma.drapeJob.update({
        where: { id: jobId },
        data: { 
          status: 'FAILED',
          errorMessage: error.message,
          latencyMs: Date.now() - startTime
        }
      });
    }
    
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: 'ERROR', error: error.message })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ success: false, error: 'Generation failed', details: error.message });
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (slotTaken) activeGenerations -= 1;

    // Cleanup the global registry
    if (activeClientJobs.get(req.body.clientId) === abortController) {
      activeClientJobs.delete(req.body.clientId);
    }
  }
});

/** Called from src/index.js on SIGTERM/SIGINT so connections are released. */
async function shutdown() {
  try { await prisma.$disconnect(); } catch (e) { console.warn('prisma disconnect:', e.message); }
  try { await pool.end(); } catch (e) { console.warn('pool end:', e.message); }
}

module.exports = router;
module.exports.shutdown = shutdown;
module.exports.stats = () => ({ activeGenerations, maxConcurrent: MAX_CONCURRENT_GENERATIONS, trackedClients: activeClientJobs.size });
