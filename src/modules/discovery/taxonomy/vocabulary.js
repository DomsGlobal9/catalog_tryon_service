// =============================================================================
// vocabulary.js — Descriptive words the instruction parser recognises.
// =============================================================================
//
// These are NOT garments or design areas (those live in garments.js and
// designTypes.js). They are the adjectives a boutique actually types: colours,
// fabrics, occasions and craft techniques.
//
// Their job is narrow. The parser keeps every recognised word as a search
// keyword — it does not sort them into structured filters — so this list exists
// mainly to distinguish "meaningful description" from "filler", and to protect
// multi-word phrases like "heavy zari" from being split into two useless tokens.

// ── Multi-word phrases, matched BEFORE single words ──────────────────────────
// Longest-first matching means "heavy zari" survives intact rather than becoming
// "heavy" + "zari". Order within the array does not matter; length does.
const PHRASES = [
  // craft / work techniques
  'zari work', 'heavy zari', 'light zari', 'hand embroidery', 'heavy embroidery',
  'light embroidery', 'machine embroidery', 'mirror work', 'thread work',
  'sequin work', 'sequins work', 'stone work', 'aari work', 'zardosi work',
  'mukaish work', 'gota patti', 'gota work', 'kundan work', 'pearl work',
  'applique work', 'cut work', 'chikankari work', 'resham work', 'dabka work',
  'temple border', 'contrast border', 'broad border', 'thin border',

  // print techniques
  'block print', 'digital print', 'screen print', 'hand painted', 'hand block',

  // colours that are two words
  'rani pink', 'bottle green', 'royal blue', 'sea green', 'off white',
  'dark green', 'light pink', 'dusty pink', 'mustard yellow', 'wine red',
  'peacock blue', 'emerald green', 'rose gold',

  // fabrics that are two words
  'raw silk', 'art silk', 'soft silk', 'pure silk', 'mysore silk', 'tussar silk',
  'georgette silk', 'cotton silk', 'silk cotton',

  // occasions that are two words
  'daily wear', 'party wear', 'office wear', 'festive wear', 'wedding wear',
  'bridal wear', 'casual wear'
];

const COLOURS = [
  'red', 'blue', 'green', 'yellow', 'pink', 'black', 'white', 'gold', 'golden',
  'silver', 'maroon', 'magenta', 'purple', 'violet', 'orange', 'peach', 'beige',
  'cream', 'ivory', 'navy', 'teal', 'turquoise', 'mustard', 'rust', 'wine',
  'lavender', 'grey', 'gray', 'brown', 'coral', 'mint', 'olive', 'bronze',
  'copper', 'multicolour', 'multicolor', 'pastel', 'neon'
];

const FABRICS = [
  'silk', 'cotton', 'georgette', 'chiffon', 'crepe', 'satin', 'velvet', 'organza',
  'tissue', 'net', 'banarasi', 'kanjivaram', 'kanchipuram', 'kanjeevaram',
  'tussar', 'linen', 'chanderi', 'muslin', 'brocade', 'jacquard', 'rayon',
  'viscose', 'khadi', 'patola', 'ikat', 'bandhani', 'bandhej', 'leheriya',
  'paithani', 'chikankari', 'kalamkari', 'pochampally', 'gadwal', 'narayanpet',
  'maheshwari', 'bhagalpuri', 'sambalpuri', 'jamdani', 'velvet', 'shimmer'
];

const OCCASIONS = [
  'bridal', 'bride', 'wedding', 'party', 'festive', 'festival', 'casual',
  'formal', 'engagement', 'reception', 'sangeet', 'mehendi', 'mehndi', 'haldi',
  'puja', 'pooja', 'traditional', 'ethnic', 'office', 'college', 'summer',
  'winter', 'designer', 'premium', 'luxury'
];

// ── Filler stripped before keyword extraction ────────────────────────────────
// Deliberately excludes 'work', 'print', 'border', 'body', 'hand' and similar:
// those are design-area aliases and stripping them would break designType
// resolution. Only words that carry no search value belong here.
const FILLER = new Set([
  'i', 'we', 'my', 'our', 'me', 'us', 'you',
  'want', 'wants', 'need', 'needs', 'looking', 'look', 'show', 'find', 'get',
  'give', 'send', 'search', 'searching', 'please', 'pls', 'plz', 'kindly',
  'like', 'want to', 'would', 'can', 'could', 'should',
  'design', 'designs', 'designing', 'designed',
  'image', 'images', 'photo', 'photos', 'picture', 'pictures', 'pic', 'pics',
  'idea', 'ideas', 'reference', 'references', 'sample', 'samples',
  'style', 'styles', 'type', 'types', 'kind', 'kinds', 'model', 'models',
  'latest', 'new', 'best', 'good', 'nice', 'beautiful', 'lovely', 'some', 'any',
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'to',
  'is', 'are', 'was', 'were', 'be', 'it', 'this', 'that', 'these', 'those',
  'from', 'by', 'as', 'having', 'has', 'have', 'want', 'plz'
]);

/** Every single-word descriptive term the parser treats as meaningful. */
const DESCRIPTIVE = new Set([...COLOURS, ...FABRICS, ...OCCASIONS]);

module.exports = { PHRASES, COLOURS, FABRICS, OCCASIONS, FILLER, DESCRIPTIVE };
