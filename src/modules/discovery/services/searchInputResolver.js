// =============================================================================
// searchInputResolver.js — Merge structured + parsed input into one request.
// =============================================================================
//
// Sits between shape validation (zod) and the search itself. Zod checks types
// and ranges; this checks meaning. Keeping them apart is what avoids encoding
// 107 cross-field rules in a schema.
//
//   validated body -> parse instruction -> merge -> canonicalise -> validate pair
//
const taxonomy = require('../taxonomy');
const { parseInstruction } = require('./instructionParser');
const { ValidationError } = require('../lib/errors');

/**
 * @param   {Object} input  Output of middleware/validate.js
 * @returns {Object} resolved search input plus an `interpreted` block for the
 *                   response, so a caller can always see what we understood.
 */
function resolveSearchInput(input) {
  const parsed = input.instruction ? parseInstruction(input.instruction) : null;

  // Explicit fields always beat parsed ones: a caller who names a category
  // means it, and the parser only fills the gaps it left.
  const explicitCategory = input.category || null;
  const explicitDesignType = input.designType || null;
  const explicitKeywords = Array.isArray(input.keywords) && input.keywords.length ? input.keywords : null;

  const rawCategory = explicitCategory || (parsed && parsed.category) || null;
  const keywords = explicitKeywords || (parsed ? parsed.keywords : []) || [];

  // --- garment ---
  let garment = null;
  if (rawCategory) {
    garment = taxonomy.getGarment(rawCategory);
    if (!garment) {
      throw new ValidationError(`Unknown category "${rawCategory}".`, [
        { field: 'category', message: `Valid categories: ${taxonomy.GARMENT_IDS.join(', ')}` }
      ]);
    }
  }

  // A parsed designType is only meaningful for the garment it was resolved
  // against. If an explicit `category` overrides the one the parser found -
  // instruction "blue blouse neck" sent with category SAREE - the parsed NECK
  // belongs to BLOUSE and must not be transplanted onto a saree. Drop it rather
  // than rejecting the request; the explicit category is what the caller meant.
  let rawDesignType = explicitDesignType;
  if (!rawDesignType && parsed && parsed.designType && garment && parsed.category === garment.id) {
    rawDesignType = parsed.designType;
  }

  // --- design area ---
  let area = null;
  if (rawDesignType) {
    if (!garment) {
      throw new ValidationError(
        'designType requires a category — a design area cannot be resolved without its garment.',
        [{ field: 'designType', message: 'Provide `category` alongside `designType`.' }]
      );
    }
    area = taxonomy.getDesignType(garment.id, rawDesignType);
    if (!area) {
      throw new ValidationError(
        `"${rawDesignType}" is not a design area of ${garment.name}.`,
        [{ field: 'designType', message: `Valid for ${garment.id}: ${taxonomy.designTypeIds(garment.id).join(', ')}` }]
      );
    }
  }

  // --- something to search for ---
  if (!keywords.length && !garment) {
    throw new ValidationError(
      input.instruction
        ? 'Could not understand the instruction — no garment or search terms were recognised.'
        : 'Provide `keywords`, or a `category`, or an `instruction`.',
      input.instruction ? [{ field: 'instruction', message: `Received: "${input.instruction}"` }] : undefined
    );
  }

  let source = 'structured';
  if (parsed) source = (explicitCategory || explicitDesignType || explicitKeywords) ? 'mixed' : 'instruction';

  return {
    clientId: input.clientId,
    category: garment ? garment.id : null,
    designType: area ? area.id : null,
    keywords,
    filters: input.filters || {},
    shotType: input.shotType,
    page: input.page,
    limit: input.limit,

    // Returned on every search, not only parsed ones — it is also how a caller
    // sees that LEHENGA was canonicalised to LEHANGA.
    interpreted: {
      category: garment ? garment.id : null,
      categoryName: garment ? garment.name : null,
      designType: area ? area.id : null,
      designTypeName: area ? area.name : null,
      keywords,
      source,
      confidence: parsed ? parsed.confidence : 'high',
      unresolved: parsed ? parsed.unresolved : []
    }
  };
}

module.exports = { resolveSearchInput };
