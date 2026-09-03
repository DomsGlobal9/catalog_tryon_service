// =============================================================================
// discovery.routes.js — Router for /api/v1/discovery/*
// =============================================================================
const express = require('express');
const { config } = require('./discovery.config');
const { validateBody, searchSchema } = require('./middleware/validate');
const { searchRateLimit } = require('./middleware/rateLimit');
const { discoveryErrorHandler } = require('./lib/errors');
const controller = require('./discovery.controller');

const router = express.Router();

// This router carries its own JSON parser so keyword searches are held to a
// small ceiling. It is mounted in src/index.js BEFORE the service-wide 50mb
// parser (which exists for base64 image uploads) — otherwise the body would
// already be parsed by the time it reached here and this limit would be moot.
router.use(express.json({ limit: config.bodyLimit }));

router.get('/categories', controller.categories);
router.post('/search', validateBody(searchSchema), searchRateLimit, controller.search);

// Module-local error handler: keeps discovery's 4xx-first status policy from
// ever touching the draping routes.
router.use(discoveryErrorHandler);

module.exports = router;
