// =============================================================================
// validate.js — Request validation for the discovery endpoints.
// =============================================================================
const { z } = require('zod');
const { config, CATEGORIES } = require('../discovery.config');
const { ValidationError } = require('../lib/errors');

const SHOT_TYPES = ['flatlay', 'worn', 'any'];

/** Accept 'saree' / 'Saree' / 'SAREE' alike rather than punishing casing. */
const upperCased = (schema) =>
  z.preprocess((value) => (typeof value === 'string' ? value.trim().toUpperCase() : value), schema);

const lowerCased = (schema) =>
  z.preprocess((value) => (typeof value === 'string' ? value.trim().toLowerCase() : value), schema);

const filterValue = z.string().trim().min(1).max(64);

const searchSchema = z.object({
  clientId: z.string().trim().min(1).max(128),

  keywords: z
    .array(z.string().trim().min(1).max(64))
    .min(1, 'At least one keyword is required.')
    .max(config.search.maxKeywords),

  category: upperCased(z.enum(CATEGORIES)).optional(),

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
});

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
