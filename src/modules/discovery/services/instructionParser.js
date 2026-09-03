// =============================================================================
// instructionParser.js — One line of natural language -> a structured search.
// =============================================================================
//
//   "i want red bridal kanjivaram saree pallu designs with heavy zari"
//        -> { category: 'SAREE', designType: 'PALLU',
//             keywords: ['red', 'bridal', 'kanjivaram', 'heavy zari'] }
//
// Deterministic lexicon matching over the taxonomy's own alias tables. No LLM:
// zero cost, zero added latency, no new dependency, and every result is
// reproducible and testable.
//
// It returns `confidence` and `unresolved` so an LLM fallback can later be
// bolted on for the cases this cannot handle, WITHOUT changing this interface.
// That fallback is deliberately not built yet — real failures should justify it.
//
const taxonomy = require('../taxonomy');
const { PHRASES, FILLER, DESCRIPTIVE } = require('../taxonomy/vocabulary');

// Longest alias/phrase seen is 3 words ("salwar kameez", "sharara pants").
const MAX_NGRAM = 3;

const PHRASE_SET = new Set(PHRASES);

/** Lowercase words, punctuation discarded. "off-white" becomes "off white". */
function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Leftmost-longest scan. Walks n-grams from MAX_NGRAM down to 1 so that
 * "salwar kameez" is preferred over a bare "salwar", and stops at the first
 * match. `lookup` returns a truthy value for a hit.
 *
 * @returns {{ value: any, start: number, length: number }|null}
 */
function findLongest(tokens, consumed, lookup, maxN = MAX_NGRAM) {
  for (let n = Math.min(maxN, tokens.length); n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      let free = true;
      for (let k = i; k < i + n; k++) if (consumed[k]) { free = false; break; }
      if (!free) continue;

      const phrase = tokens.slice(i, i + n).join(' ');
      const value = lookup(phrase);
      if (value) return { value, start: i, length: n };
    }
  }
  return null;
}

function consume(consumed, start, length) {
  for (let k = start; k < start + length; k++) consumed[k] = true;
}

/**
 * @param   {string} instruction
 * @returns {{
 *   category: string|null, designType: string|null,
 *   keywords: string[], unresolved: string[], confidence: 'high'|'medium'|'low'
 * }}
 */
function parseInstruction(instruction) {
  const empty = { category: null, designType: null, keywords: [], unresolved: [], confidence: 'low' };
  if (typeof instruction !== 'string' || !instruction.trim()) return empty;

  const tokens = tokenize(instruction);
  if (!tokens.length) return empty;
  const consumed = new Array(tokens.length).fill(false);

  // 1. Garment first. Design areas are meaningless without one - "border" and
  //    "neck" belong to many garments, and "dupatta" is both a garment and an
  //    area of Anarkali/Lehenga/Sharara. Matching the garment first is what
  //    disambiguates them.
  let category = null;
  const garmentHit = findLongest(tokens, consumed, (p) => taxonomy.getGarment(p));
  if (garmentHit) {
    category = garmentHit.value.id;
    consume(consumed, garmentHit.start, garmentHit.length);
  }

  // 2. Design area, scoped strictly to that garment. If no garment was
  //    identified we leave designType unset rather than guessing.
  let designType = null;
  if (category) {
    const areaHit = findLongest(tokens, consumed, (p) => taxonomy.getDesignType(category, p));
    if (areaHit) {
      designType = areaHit.value.id;
      consume(consumed, areaHit.start, areaHit.length);
    }
  }

  // 3. Multi-word descriptive phrases, so "heavy zari" survives as one keyword
  //    instead of splitting into two far less useful tokens.
  // Each keyword is recorded with the position it appeared at, so the final
  // list reads back in the order the caller wrote it rather than in the order
  // our matcher happened to find things.
  const found = [];
  let phraseHit;
  while ((phraseHit = findLongest(tokens, consumed, (p) => (PHRASE_SET.has(p) ? p : null), MAX_NGRAM))) {
    if (phraseHit.length < 2) break; // single words are handled below
    found.push({ at: phraseHit.start, word: phraseHit.value });
    consume(consumed, phraseHit.start, phraseHit.length);
  }

  // 4. Remaining single words: drop filler, keep everything else as a keyword.
  //    Anything kept that we do not recognise is also reported in `unresolved`,
  //    which is the signal a future LLM fallback would act on.
  const unresolved = [];
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue;
    const token = tokens[i];
    if (FILLER.has(token)) continue;
    if (token.length < 2) continue;
    found.push({ at: i, word: token });
    if (!DESCRIPTIVE.has(token)) unresolved.push(token);
  }

  // Source order, duplicates dropped.
  found.sort((a, b) => a.at - b.at);
  const seen = new Set();
  const uniqueKeywords = found
    .map((f) => f.word)
    .filter((k) => (seen.has(k) ? false : (seen.add(k), true)));

  let confidence = 'low';
  if (category && (designType || uniqueKeywords.length)) confidence = 'high';
  else if (category || uniqueKeywords.length) confidence = 'medium';

  return { category, designType, keywords: uniqueKeywords, unresolved, confidence };
}

module.exports = { parseInstruction, tokenize };
