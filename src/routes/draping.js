// =============================================================================
// draping.js — dispatcher for the catalog pipelines mounted at /api/v1/draping
// =============================================================================
//
//   /generate-catalog  ->  /generate-catalog/women   (catalogRoutes.js)
//                     ->  /generate-catalog/men     (menRoutes.js)
//
// The women pipeline is the original catalog service; the men pipeline was added
// alongside it. Both are reached through the same public path so a caller does
// not need to know the routing.
//
// BACKWARD COMPATIBILITY MATTERS HERE.
// The dispatcher introduced on merge/catlog required `category` to be literally
// "women" or "men" and moved the garment type to `garmentCategory`. That is a
// breaking change: every existing caller sends `category: "SAREE"` and would
// have started receiving 400s, including the frontend, the API documentation and
// every third-party integration.
//
// So `category` is now interpreted rather than demanded:
//
//   "women" / "men"                     -> explicit pipeline, garment type from
//                                          `garmentCategory`
//   a men's garment (FORMALS, BLAZER,
//   KURTA_PAJAMA, SHERWANI)             -> men pipeline, category kept as-is
//   anything else, or omitted           -> women pipeline, category kept as-is
//                                          (the original behaviour)
//
const express = require('express');
const router = express.Router();

const catalogRouter = require('./catalogRoutes');
const menRouter = require('./menRoutes');

/** Garment types that only exist in the men pipeline. */
const MEN_GARMENTS = new Set(['FORMALS', 'BLAZER', 'KURTA_PAJAMA', 'SHERWANI']);

const DEFAULT_WOMEN_GARMENT = 'SAREE';
const DEFAULT_MEN_GARMENT = 'FORMALS';

router.post('/generate-catalog', (req, res, next) => {
  const raw = typeof req.body.category === 'string' ? req.body.category.trim() : '';
  const upper = raw.toUpperCase();

  // 1. Explicit pipeline selection.
  if (upper === 'WOMEN' || upper === 'MEN') {
    const isMen = upper === 'MEN';
    req.url = isMen ? '/generate-catalog/men' : '/generate-catalog/women';
    req.body.category = req.body.garmentCategory
      || (isMen ? DEFAULT_MEN_GARMENT : DEFAULT_WOMEN_GARMENT);
    return next();
  }

  // 2. A men's garment type implies the men pipeline.
  if (MEN_GARMENTS.has(upper)) {
    req.url = '/generate-catalog/men';
    return next();
  }

  // 3. Everything else - a women's garment, an unrecognised one, or nothing at
  //    all - goes to the women pipeline unchanged. This is what keeps existing
  //    callers working; the women service already defaults an absent category
  //    to SAREE and tolerates unknown values.
  req.url = '/generate-catalog/women';
  return next();
});

router.post('/cancel-job', (req, res, next) => {
  // An explicit `pipeline` is honoured first, so a caller with an arbitrary
  // clientId can still cancel a men job. Without it we fall back to matching on
  // the clientIds the two bundled frontends use, and finally to women - which is
  // where every pre-existing caller's job lives.
  const pipeline = typeof req.body.pipeline === 'string' ? req.body.pipeline.trim().toLowerCase() : '';
  if (pipeline === 'men' || pipeline === 'women') {
    req.url = `/cancel-job/${pipeline}`;
    return next();
  }

  req.url = req.body.clientId === 'men-frontend' ? '/cancel-job/men' : '/cancel-job/women';
  return next();
});

router.use(catalogRouter);
router.use(menRouter);

// The women pipeline owns the database connections; surface its drain so
// src/index.js can release them on shutdown.
module.exports = router;
module.exports.shutdown = catalogRouter.shutdown;
module.exports.stats = catalogRouter.stats;
