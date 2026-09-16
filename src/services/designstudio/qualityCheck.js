// =============================================================================
// qualityCheck.js — step three: inspect the photograph before it is returned.
// =============================================================================
//
// WHY THIS EXISTS. The image model is not deterministic. With the prompt right,
// measured faults still came back in some runs and not others: a thin gold band
// on a saree blouse's sleeves (1 run in 3), light-blue stripes from a reference
// on an emerald saree (1 in 3), a dupatta on a suit, tassels nobody asked for.
// No prompt wording reaches zero. So after generating, a vision model checks the
// photograph against a checklist built from the order itself, and one failed
// check buys one regeneration with that exact fault named as a correction.
//
// The checklist only asks what can be judged from the finished photograph plus
// the order: the supporting pieces are plain, no reference background colour
// became a garment colour, printed designs look printed, the framing and the
// person are right, nothing extra was added. It does not try to grade taste.
//
// NEVER REQUIRED. Any failure of the check itself (timeout, quota, bad answer)
// means the photograph is returned unchecked, exactly as before.
//
const { config } = require('./config');
const { redact } = require('./errors');
const { sameColourFamily } = require('./colours');

let fetchImpl = (...args) => fetch(...args);

/**
 * The checks for this order. Each has an id, a yes/no question where YES means
 * the photograph is right, and the correction to give the image model if not.
 * @param {Object} review  From buildPrompt(...).review
 */
function buildChecklist(review) {
  const checks = [];
  const add = (id, question, correction) => checks.push({ id, question, correction });
  const product = review.product;

  add('one_person',
    'Is there exactly one person, with her or his whole head and face inside the frame (not cropped at the top)?',
    'Show exactly one model, with the whole head and face inside the frame.');

  if (review.framing === 'waist-up') {
    add('framing',
      `Is it a waist-up photograph in which the whole ${product}, both sleeves and its hem, is inside the frame?`,
      `Frame the photograph waist-up with the whole ${product}, both sleeves and its hem inside the frame.`);
  } else {
    add('framing',
      `Is it a full-length photograph in which the whole ${product} is visible from top to bottom, with nothing of it cropped?`,
      `Show the model full length, head to feet, with the whole ${product} inside the frame.`);
  }

  if (review.pair) {
    const pieces = review.pair.pieces;
    const edges = `its ${review.pair.edges || 'edges, hem and neckline'}`;
    add('supporting_plain',
      `The ${pieces} is not the product and must be completely plain. Is the ${pieces} one solid colour everywhere - including ${edges} - with NO border, band, stripe, zari, gold or metallic edge, trim, piping or pattern of any width? Judge only the ${pieces}'s own cloth: the ${product}'s own border or pallu draped over it or lying across a shoulder does not count.`,
      `The ${pieces} is completely plain, one solid colour everywhere. There is NO border, band, zari, gold or metallic edge, trim or piping at ${edges} - not even a thin line.`);
  }

  if (review.noDupatta) {
    add('no_dupatta',
      'Is the model wearing NO dupatta, stole, shawl or scarf?',
      'No dupatta, stole, shawl or scarf of any kind.');
  }
  if (review.noTassels) {
    add('no_tassels',
      `Does the ${product} have NO tassels, latkans, pom-poms or bead drops on its ends?`,
      `No tassels, latkans, pom-poms or bead drops on the ${product} ends.`);
  }
  if (review.onePallu) {
    add('one_pallu',
      'Does the saree show exactly ONE pallu (one decorated end over one shoulder), not two?',
      'The saree has exactly one pallu, over the left shoulder only.');
  }

  for (const part of review.parts) {
    // Measured: "gold" on a gold tissue pallu and gold zari motifs in a border were
    // flagged as wrong colours. Only a background clearly unlike the ground is
    // checked, and motif colours are explicitly allowed.
    // Measured: amber gemstone buttons failed "ground colour is not ivory". A button
    // or tassel is attached, not cut from the cloth, so it has no ground colour.
    if (part.ground && !part.contrast && !part.zariGround && !part.trim && part.referenceBackground && !sameColourFamily(part.referenceBackground, part.ground)) {
      add(`colour_${part.area.toLowerCase()}`,
        `On the ${part.part} (${part.where}) - and only there, not on other parts of the garment - the ground (background) colour must be ${part.ground}. The design reference was photographed on ${part.referenceBackground}. Judge ONLY the ground: the base cloth and any wide stripes, bands, checks or blocks. Motifs, buttis, zari, gold or metallic work (including a solid gold or zari panel or band) and coloured decoration are allowed in any colour, and skin seen through sheer or net fabric is not a ground colour. Is it true that ${part.referenceBackground} - and any lighter or darker shade or tint of it - does NOT appear as a ground, stripe, band, check or block colour on the ${part.part}?`,
        `On the ${part.part}, ${part.referenceBackground} and every shade or tint of it is replaced by ${part.ground}. No ${part.referenceBackground} stripes, bands or blocks.`);
    }
    if (part.printed) {
      add(`print_${part.area.toLowerCase()}`,
        `Do the motifs on the ${part.part} look PRINTED - lying flat on the cloth (a foil print may shine) - rather than raised woven zari, brocade or thread embroidery?`,
        `The design on the ${part.part} is a flat, matte PRINT: no woven zari, brocade, metallic thread or embroidery.`);
    }
  }

  if (review.plainSleeves) {
    add('plain_sleeves',
      `No sleeve design was ordered. If the ${product} has sleeves, are they plain ${product} fabric from shoulder to wrist - with NO print, embroidery, buttis, band or motif anywhere on them?`,
      `The sleeves of the ${product} are plain ${product} fabric from shoulder to wrist: no print, embroidery, buttis, band or motif anywhere on them - not copied from any reference photograph.`);
  }

  if (review.plainRest && review.plainRest.length) {
    const designed = review.plainRest.join(', ');
    add('plain_rest',
      `The ${product}'s cloth is plain and only these parts carry a design: ${designed}. Apart from those parts and what naturally belongs with them (the yoke around a neckline, a sleeve's own cuff, the edge next to a border), is the rest of the ${product} plain cloth - with NO scattered flowers, buttis, motifs, embroidery or all-over pattern?`,
      `Only these parts of the ${product} carry a design: ${designed}. Everywhere else the ${product} is plain cloth in its fabric colour - no scattered flowers, buttis, motifs, embroidery or pattern copied from any reference photograph.`);
  }

  add('no_text',
    'Is the photograph free of any text, watermark, logo, collage, split screen or inset image?',
    'No text, watermark, logo, collage or inset image anywhere.');
  return checks;
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    checks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { id: { type: 'STRING' }, pass: { type: 'BOOLEAN' }, evidence: { type: 'STRING' } },
        required: ['id', 'pass', 'evidence'],
        propertyOrdering: ['id', 'pass', 'evidence']
      }
    }
  },
  required: ['checks']
};

/**
 * @param {Object} review  From buildPrompt(...).review
 * @param {{ mimeType: string, base64: string }} image  The generated photograph
 * @returns {Promise<{ checked: boolean, failures: {id, evidence, correction}[], problem?: string, ms: number }>}
 */
async function reviewImage(review, image, { signal } = {}) {
  const started = Date.now();
  const checklist = buildChecklist(review);
  const unchecked = (problem) => ({ checked: false, failures: [], problem, ms: Date.now() - started });
  if (!config.qa.enabled || !config.gemini.apiKey()) return unchecked('disabled');

  const text = [
    'You are the quality inspector for a fashion catalogue. Look closely at this product photograph and answer each check strictly.',
    'Answer pass=true only when the check is clearly satisfied. When a fault is present even in a small area (a thin band at a sleeve end, a few stripes of the wrong colour), answer pass=false and say where in evidence (under 25 words).',
    'Answer every check, using its id.',
    '',
    ...checklist.map((c) => `- ${c.id}: ${c.question}`)
  ].join('\n');

  const timeout = AbortSignal.timeout(config.qa.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(`${config.gemini.baseUrl}/models/${encodeURIComponent(config.qa.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey() },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text }, { inlineData: { mimeType: image.mimeType, data: image.base64 } }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          maxOutputTokens: config.qa.maxOutputTokens,
          ...(/2\.5/.test(config.qa.model) ? { thinkingConfig: { thinkingBudget: config.qa.thinkingBudget } } : {})
        }
      }),
      signal: combined
    });
    if (!response.ok) return unchecked(`HTTP ${response.status} ${redact(await response.text().catch(() => '')).slice(0, 120)}`);
    const json = await response.json();
    const candidate = (json.candidates || [])[0];
    const answer = ((candidate && candidate.content && candidate.content.parts) || [])
      .filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
    let parsed = null;
    try { parsed = JSON.parse(answer.replace(/```(?:json)?/gi, '').trim()); } catch { parsed = null; }
    if (!parsed || !Array.isArray(parsed.checks)) return unchecked('answer was not usable JSON');

    const byId = new Map(parsed.checks.filter((c) => c && typeof c.id === 'string').map((c) => [c.id.trim(), c]));
    // A check the inspector skipped is not a failure - only an explicit "no" is.
    if (checklist.every((c) => !byId.has(c.id))) return unchecked('answer matched no check');
    const failures = checklist
      .filter((c) => byId.has(c.id) && byId.get(c.id).pass === false)
      .map((c) => ({ id: c.id, evidence: String(byId.get(c.id).evidence || '').slice(0, 200), correction: c.correction }));
    return { checked: true, failures, ms: Date.now() - started };
  } catch (err) {
    if (signal && signal.aborted) throw err;
    return unchecked(redact(err && err.message));
  }
}

/** The text appended to the prompt for the one regeneration. */
function correctionsText(failures) {
  return [
    'CORRECTIONS - IMPORTANT',
    'A previous photograph made from these same instructions was inspected and had these faults. This photograph must not have them:',
    ...failures.map((f) => `- ${f.correction}`),
    'Everything else in the instructions above still applies.'
  ].join('\n');
}

module.exports = { reviewImage, buildChecklist, correctionsText, sameColourFamily, RESPONSE_SCHEMA, _setFetch: (fn) => { fetchImpl = fn; } };
