// =============================================================================
// validate.js — Request validation for the discovery endpoints.
// =============================================================================
//
// SHAPE ONLY. Types, lengths and ranges live here; meaning lives in
// services/searchInputResolver.js. That split is deliberate — `category` and
// `designType` are checked against the taxonomy (including alias resolution and
// the garment/area relationship), which is not something a zod enum can express
// without hardcoding 107 combinations.
//
const { z } = require('zod');
const { config } = require('../discovery.config');
const { ValidationError } = require('../lib/errors');

const SHOT_TYPES = ['flatlay', 'worn', 'any'];

const lowerCased = (schema) =>
  z.preprocess((value) => (typeof value === 'string' ? value.trim().toLowerCase() : value), schema);

const filterValue = z.string().trim().min(1).max(64);

const searchSchema = z
  .object({
    clientId: z.string().trim().min(1).max(128),

    // Optional: a caller may instead send `instruction`, or search a whole
    // garment with `category` alone.
    keywords: z
      .array(z.string().trim().min(1).max(64))
      .max(config.search.maxKeywords)
      .optional(),

    // One line of natural language, resolved by the lexicon parser.
    instruction: z.string().trim().min(1).max(500).optional(),

    // Free-form strings here, not enums: "LEHENGA", "lehanga" and "Lehenga" are
    // all valid input and the resolver canonicalises them to LEHANGA.
    category: z.string().trim().min(1).max(64).optional(),
    designType: z.string().trim().min(1).max(64).optional(),

    filters: z
      .object({
        color: filterValue.optional(),
        fabric: filterValue.optional(),
        occasion: filterValue.optional()
      })
      .default({}),

    shotType: lowerCased(z.enum(SHOT_TYPES)).default('any'),

    // Coerced so "2" from a loosely-typed caller is accepted rather than rejected.
    page: z.coerce.number().int().min(1).max(config.search.maxPage).default(1),
    limit: z.coerce.number().int().min(1).max(config.search.maxLimit).default(config.search.defaultLimit)
  })
  .refine(
    (v) => (v.keywords && v.keywords.length > 0) || v.instruction || v.category,
    { message: 'Provide at least one of `keywords`, `category` or `instruction`.', path: ['keywords'] }
  );

/**
 * Express middleware factory. On success attaches the parsed, defaulted result
 * to req.validated; on failure throws ValidationError (400) with per-field detail.
 */
function validateBody(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body ?? {});

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(body)',
        message: issue.message
      }));
      return next(new ValidationError('Request validation failed.', details));
    }

    req.validated = result.data;
    next();
  };
}

module.exports = { validateBody, searchSchema, SHOT_TYPES };
