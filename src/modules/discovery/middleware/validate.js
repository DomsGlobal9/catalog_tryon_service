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
const { SOURCES } = require('../services/platforms');

const SHOT_TYPES = ['flatlay', 'worn', 'any'];
const ORIENTATIONS = ['portrait', 'landscape', 'square'];

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

    // Where to search. Each entry is one provider call. Defaults to ['web'], which
    // is exactly the search that existed before this field did. Repeats are
    // collapsed, so ['pinterest', 'Pinterest'] is one Pinterest search, not two.
    sources: z
      .preprocess(
        // Normalise and collapse repeats BEFORE the size check, so four distinct
        // platforms with one written twice is accepted rather than counted as five.
        // A single string is taken as a list of one: "pinterest" means ["pinterest"].
        (value) => {
          const list = typeof value === 'string' ? [value] : value;
          return Array.isArray(list)
            ? [...new Set(list.map((s) => (typeof s === 'string' ? s.trim().toLowerCase() : s)))]
            : list;
        },
        z.array(z.enum(SOURCES)).min(1).max(config.search.maxSources)
      )
      .default(['web']),

    // Checked against each result's real data, so unlike `filters` these are
    // guaranteed. See services/resultFilters.js.
    resultFilters: z
      .object({
        fullSizeOnly: z.boolean().optional(),
        minWidth: z.coerce.number().int().min(1).max(10000).optional(),
        orientation: lowerCased(z.enum(ORIENTATIONS)).optional(),
        excludeDomains: z.array(z.string().trim().min(1).max(253)).max(20).optional()
      })
      .strict()
      .default({}),

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

module.exports = { validateBody, searchSchema, SHOT_TYPES, ORIENTATIONS };
