// =============================================================================
// routes.js — Design Studio endpoints, mounted at /api/v1/designstudio.
// =============================================================================
//
// Mounted before the service-wide 50 MB body parser so this service's own
// limit applies, and with its own error handler so its failures keep their
// 4xx codes and never reach the generic 500 handler.
//
const express = require('express');
const { config } = require('./config');
const controller = require('./controller');
const { studioErrorHandler } = require('./errors');

const router = express.Router();

router.use(express.json({ limit: `${config.limits.maxBodyMb}mb` }));

router.get('/options', controller.options);
router.post('/generate', controller.generate);
// A hand-drawn sketch with labelled colours, made into a photograph (since 28 Oct 2026).
router.post('/sketch', require('./sketchController').sketch);
router.post('/cancel', controller.cancel);
router.get('/result/:jobId', controller.result);

router.use((req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `${req.method} ${req.originalUrl} does not exist.`, retryable: false } });
});
router.use(studioErrorHandler);

module.exports = router;
