const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');
const aiGenerationService = require('../services/aiGenerationService');

// Global registry to track active jobs per client to kill zombies on page refresh
const activeClientJobs = new Map();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

router.get('/debug-model', async (req, res) => {
  try {
    const model = await prisma.aiModel.findUnique({ where: { id: 'saree1' } });
    res.json({ model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/generate-catalog', async (req, res) => {
  const startTime = Date.now();
  let jobId = null;
  let abortController = null;

  try {
    const { clientId, modelId, bottom } = req.body;
    let category = req.body.category || 'SAREE';
    
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

    if (!model) {
      return res.status(404).json({ success: false, error: 'AI Model not found' });
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

    // 3. Initiate the Generation Service Flow
    const generatedViews = await aiGenerationService.generate4ViewCatalog(
      { fullDress, topFront, topBack, bottom, category: safeCategory },
      {
        front: model.frontBaseUrl,
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
    // Cleanup the global registry
    if (activeClientJobs.get(req.body.clientId) === abortController) {
      activeClientJobs.delete(req.body.clientId);
    }
  }
});

module.exports = router;
