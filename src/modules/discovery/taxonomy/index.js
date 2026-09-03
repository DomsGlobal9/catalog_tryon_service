// =============================================================================
// taxonomy/index.js — Lookup, canonicalisation and integrity for the taxonomy.
// =============================================================================
//
// The single entry point to the taxonomy. Everything else in the module asks
// this file; nothing else reads garments.js or designTypes.js directly, and the
// search provider never sees any of it.
//
// Three concerns are kept deliberately separate, which is what lets the API say
// LEHANGA, the UI say "Lehenga", and Google receive "lehenga":
//
//   id          canonical, stable, matches the generation service's spelling
//   name        display label for the Manage Designs UI
//   searchNoun  what actually goes into the provider query
//
const { GARMENTS } = require('./garments');
const { DESIGN_TYPES } = require('./designTypes');

// Expected totals. These are asserted, not assumed: writing 107 entries by hand
// is exactly the kind of task that silently ends up at 106 or 108.
const EXPECTED_GARMENTS = 12;
const EXPECTED_DESIGN_AREAS = 107;

// ── Integrity ────────────────────────────────────────────────────────────────

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Check every structural invariant. Returns a report rather than throwing, so
 * the caller decides the blast radius:
 *   - tests call assertIntegrity() and fail hard
 *   - boot logs the errors and disables discovery, leaving generation running
 */
function checkIntegrity() {
  const errors = [];

  if (GARMENTS.length !== EXPECTED_GARMENTS) {
    errors.push(`Expected ${EXPECTED_GARMENTS} garments, found ${GARMENTS.length}.`);
  }

  const garmentIds = new Set();
  const aliasOwner = new Map();
  let totalAreas = 0;

  for (const garment of GARMENTS) {
    if (!isNonEmptyString(garment.id) || !isNonEmptyString(garment.name) || !isNonEmptyString(garment.searchNoun)) {
      errors.push(`Garment ${JSON.stringify(garment.id)} is missing id, name or searchNoun.`);
      continue;
    }
    if (garmentIds.has(garment.id)) errors.push(`Duplicate garment id "${garment.id}".`);
    garmentIds.add(garment.id);

    if (!Array.isArray(garment.aliases) || garment.aliases.length === 0) {
      errors.push(`Garment "${garment.id}" has no aliases.`);
    } else {
      for (const alias of garment.aliases) {
        if (!isNonEmptyString(alias) || alias !== alias.toLowerCase()) {
          errors.push(`Garment "${garment.id}" has a non-lowercase or empty alias ${JSON.stringify(alias)}.`);
          continue;
        }
        if (aliasOwner.has(alias) && aliasOwner.get(alias) !== garment.id) {
          errors.push(`Alias "${alias}" resolves to both "${aliasOwner.get(alias)}" and "${garment.id}".`);
        }
        aliasOwner.set(alias, garment.id);
      }
    }

    const areas = DESIGN_TYPES[garment.id];
    if (!Array.isArray(areas) || areas.length === 0) {
      errors.push(`Garment "${garment.id}" has no design areas.`);
      continue;
    }
    totalAreas += areas.length;

    const areaIds = new Set();
    let hasOverall = false;
    for (const area of areas) {
      if (!isNonEmptyString(area.id) || !isNonEmptyString(area.name)) {
        errors.push(`Design area in "${garment.id}" is missing id or name.`);
        continue;
      }
      if (areaIds.has(area.id)) {
        errors.push(`Duplicate design area id "${area.id}" within "${garment.id}".`);
      }
      areaIds.add(area.id);
      if (area.id === 'OVERALL') hasOverall = true;

      if (!Array.isArray(area.aliases) || area.aliases.length === 0) {
        errors.push(`Design area "${garment.id}.${area.id}" has no aliases.`);
      } else if (area.aliases.some((a) => !isNonEmptyString(a) || a !== a.toLowerCase())) {
        errors.push(`Design area "${garment.id}.${area.id}" has a non-lowercase or empty alias.`);
      }

      if (!Array.isArray(area.queryTerms)) {
        errors.push(`Design area "${garment.id}.${area.id}" has no queryTerms array.`);
      } else if (area.queryTerms.some((t) => !isNonEmptyString(t))) {
        errors.push(`Design area "${garment.id}.${area.id}" has an empty query term.`);
      } else if (area.queryTerms.length === 0 && area.id !== 'OVERALL') {
        errors.push(`Design area "${garment.id}.${area.id}" has empty queryTerms but is not OVERALL.`);
      }
    }

    if (!hasOverall) errors.push(`Garment "${garment.id}" has no OVERALL design area.`);
  }

  for (const key of Object.keys(DESIGN_TYPES)) {
    if (!garmentIds.has(key)) errors.push(`DESIGN_TYPES key "${key}" matches no garment.`);
  }

  if (totalAreas !== EXPECTED_DESIGN_AREAS) {
    errors.push(`Expected ${EXPECTED_DESIGN_AREAS} design areas in total, found ${totalAreas}.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    garmentCount: GARMENTS.length,
    designAreaCount: totalAreas
  };
}

const integrity = checkIntegrity();

/** Hard failure, for tests and build gates. */
function assertIntegrity() {
  if (!integrity.ok) {
    throw new Error('Discovery taxonomy integrity check failed:\n  - ' + integrity.errors.join('\n  - '));
  }
  return integrity;
}

// ── Indexes (built once) ─────────────────────────────────────────────────────

const byId = new Map();
const byAlias = new Map();

for (const garment of GARMENTS) {
  if (!garment || !garment.id) continue;
  byId.set(garment.id, garment);
  byAlias.set(garment.id.toLowerCase(), garment);
  for (const alias of garment.aliases || []) byAlias.set(alias, garment);
}

/** Design areas indexed per garment, by id and by alias. */
const areaIndex = new Map();
for (const garment of GARMENTS) {
  const map = new Map();
  for (const area of DESIGN_TYPES[garment.id] || []) {
    if (!area || !area.id) continue;
    map.set(area.id.toLowerCase(), area);
    for (const alias of area.aliases || []) map.set(alias, area);
  }
  areaIndex.set(garment.id, map);
}

// ── Public lookup ────────────────────────────────────────────────────────────

/**
 * Resolve any spelling of a garment to its canonical record.
 * Accepts "LEHENGA", "lehanga", "Lehenga" -> the LEHANGA garment.
 * @returns {Object|null}
 */
function getGarment(input) {
  if (!isNonEmptyString(input)) return null;
  const key = input.trim().toLowerCase();
  return byAlias.get(key) || null;
}

/** @returns {string|null} canonical garment id, or null if unrecognised. */
function canonicaliseGarment(input) {
  const garment = getGarment(input);
  return garment ? garment.id : null;
}

/**
 * Resolve a design area WITHIN a garment. Scoping to the garment is essential:
 * "border", "neck" and "dupatta" are areas of several garments and mean nothing
 * on their own.
 * @returns {Object|null}
 */
function getDesignType(garmentId, input) {
  if (!isNonEmptyString(input)) return null;
  const map = areaIndex.get(garmentId);
  if (!map) return null;
  return map.get(input.trim().toLowerCase()) || null;
}

/** All design areas for a garment, in declaration order. */
function getDesignTypes(garmentId) {
  return DESIGN_TYPES[garmentId] || [];
}

/** Canonical ids, for zod enums and error messages. */
const GARMENT_IDS = GARMENTS.map((g) => g.id);
const designTypeIds = (garmentId) => getDesignTypes(garmentId).map((d) => d.id);

/** The Manage Designs tree, shaped for the API. */
function getTree() {
  return GARMENTS.map((garment) => ({
    id: garment.id,
    name: garment.name,
    designTypes: getDesignTypes(garment.id).map((area) => ({ id: area.id, name: area.name }))
  }));
}

module.exports = {
  GARMENTS,
  GARMENT_IDS,
  DESIGN_TYPES,
  EXPECTED_GARMENTS,
  EXPECTED_DESIGN_AREAS,
  integrity,
  checkIntegrity,
  assertIntegrity,
  getGarment,
  canonicaliseGarment,
  getDesignType,
  getDesignTypes,
  designTypeIds,
  getTree
};
