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
        `Judge ONLY the ${part.part} (${part.where}); other parts, bands and borders may use other techniques. Do the motifs on the ${part.part} look PRINTED - lying flat on the cloth (a foil print may shine) - rather than raised woven zari, brocade or thread embroidery?`,
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

/** The checks a back photograph must pass against the front photograph. */
function pairChecklist(review) {
  const product = review.product;
  const checks = [
    // Measured on a real blouse: teal flowers on the front and gold butis on the back
    // (each side's own reference) were called "different blouses". The decoration is
    // MEANT to differ; only the cloth and the cut must match.
    ['same_garment', `Judge the CLOTH and CUT only - the front and the back carry their own, different designs on purpose, so ignore the embroidery, motifs and decoration entirely. Is the ${product} in the BACK photograph made of the same fabric as in the FRONT photograph (same base colour and shade, same texture and sheen), with the same fit, the same length and the same neckline depth at the shoulders?`,
      `The back view is the same ${product} as the front view in cloth and cut: identical fabric base colour and shade, texture, fit and length. Its decoration follows the back design reference, not the front's.`],
    ['same_sleeves', `Are the sleeves the same in both photographs - the same length, the same shape (puff, fitted, flared), the same fabric and the same sleeve-end finish?`,
      'The sleeves are identical to the front view: same length, shape and sleeve ends.'],
    ['same_person', 'Is it the same person in both photographs - the same build, skin tone, hair colour and hair style?',
      'The same person as the front view, with the same hair and skin tone.'],
    ['back_shown', `Does the BACK photograph show the back of the ${product} squarely to the camera, with the whole back visible and nothing (hair, hands, a dupatta, a bag) covering any part of it?`,
      `The back of the ${product} faces the camera squarely and is completely visible; hair is pinned up or brought forward, and nothing covers the back.`],
    ['no_front_on_back', `Is it true that the BACK photograph does NOT show the front neckline, front panel or placket of the ${product} (that is, it is not actually a front or three-quarter-front view)?`,
      `The photograph is a true back view: the front of the ${product} is not visible.`],
    ['same_studio', 'Are the backdrop, lighting and framing the same in both photographs?',
      'The same plain studio backdrop, lighting and framing as the front view.']
  ];
  if (review.pair) {
    checks.push(['same_supporting', `Is the ${review.pair.pieces} worn with the ${product} the same colour and style in both photographs?`,
      `The ${review.pair.pieces} is the same colour and style as in the front view.`]);
  }
  return checks.map(([id, question, correction]) => ({ id, question, correction }));
}

/**
 * Compare a back photograph with the front photograph it was made from.
 * Same shape of answer as reviewImage. Never required.
 */
async function reviewPair(review, frontImage, backImage, { signal } = {}) {
  const started = Date.now();
  const checklist = pairChecklist(review);
  const unchecked = (problem) => ({ checked: false, failures: [], problem, ms: Date.now() - started });
  if (!config.pair.enabled || !config.gemini.apiKey()) return unchecked('disabled');
  const text = [
    'You are the quality inspector for a fashion catalogue. The first picture is the FRONT view of a garment on a model; the second is meant to be the BACK view of the same garment on the same model.',
    'Answer each check strictly: pass=true only when it is clearly satisfied. When something differs, answer pass=false and say what differs in evidence (under 25 words).',
    'Answer every check, using its id.',
    '',
    ...checklist.map((c) => `- ${c.id}: ${c.question}`)
  ].join('\n');
  const timeout = AbortSignal.timeout(config.pair.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl(`${config.gemini.baseUrl}/models/${encodeURIComponent(config.pair.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey() },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text },
          { text: 'FRONT view:' }, { inlineData: { mimeType: frontImage.mimeType, data: frontImage.base64 } },
          { text: 'BACK view:' }, { inlineData: { mimeType: backImage.mimeType, data: backImage.base64 } }
        ] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          maxOutputTokens: 2048,
          ...(/2\.5/.test(config.pair.model) ? { thinkingConfig: { thinkingBudget: 0 } } : {})
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

module.exports = { reviewImage, reviewPair, pairChecklist, buildChecklist, correctionsText, sameColourFamily, RESPONSE_SCHEMA, _setFetch: (fn) => { fetchImpl = fn; } };
