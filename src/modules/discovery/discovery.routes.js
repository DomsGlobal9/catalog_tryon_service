// =============================================================================
// discovery.routes.js — Router for /api/v1/discovery/*
// =============================================================================
const express = require('express');
const { config } = require('./discovery.config');
const taxonomy = require('./taxonomy');
const { validateBody, searchSchema } = require('./middleware/validate');
const { searchRateLimit } = require('./middleware/rateLimit');
const { discoveryErrorHandler, AppError } = require('./lib/errors');
const controller = require('./discovery.controller');

const router = express.Router();

// This router carries its own JSON parser so keyword searches are held to a
// small ceiling. It is mounted in src/index.js BEFORE the service-wide 50mb
// parser (which exists for base64 image uploads) — otherwise the body would
// already be parsed by the time it reached here and this limit would be moot.
router.use(express.json({ limit: config.bodyLimit }));

/**
 * A corrupt taxonomy disables discovery rather than taking the process down —
 * generate-catalog is unrelated and must keep working. 424 keeps it out of the
 * gateway's per-slug circuit breaker. The hard gate for this is the test suite.
 */
router.use((_req, _res, next) => {
  if (taxonomy.integrity.ok) return next();
  next(new AppError(
    'Design discovery is unavailable: the garment taxonomy failed its integrity check.',
    { statusCode: 424, code: 'TAXONOMY_INVALID', details: taxonomy.integrity.errors }
  ));
});

router.get('/categories', controller.categories);
router.get('/taxonomy', controller.taxonomy);
router.post('/search', validateBody(searchSchema), searchRateLimit, controller.search);

// Module-local error handler: keeps discovery's 4xx-first status policy from
// ever touching the draping routes.
router.use(discoveryErrorHandler);

module.exports = router;
