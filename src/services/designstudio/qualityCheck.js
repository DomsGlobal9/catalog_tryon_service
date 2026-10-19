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

/**
 * The checks a photograph must pass against its own design references, and -
 * for a back view - against the front photograph it was made from.
 * @param {Object} review        buildPrompt(...).review for this view
 * @param {Object[]} references  [{ area, part, ref }] the design pictures sent for this view
 */
// Checks that compare the back photograph with the front one. Without a front
// photograph (views: ["back"] alone) they have nothing to compare with.
const NEEDS_FRONT = new Set(['same_garment', 'same_sleeves', 'same_person', 'same_mannequin', 'same_studio', 'same_supporting']);

function viewChecklist(review, references = [], { withFront = true, withGarment = false } = {}) {
  const product = review.product;
  const onMannequin = review.presentation === 'mannequin';
  const checks = [];
  // Own photo, drape step: the finished garment (on the mannequin) is the ground truth.
  // Measured 19 Oct: the customer's own elbow-length sleeves survived the drape on the front
  // only, while the garment and the back view were sleeveless.
  if (withGarment) {
    // Measured 19 Oct: the front kept the customer's own saree drape (narrow pallu strip across
    // the chest, a short end at the side) while the back was right.
    const saree = review.garmentId === 'SAREE';
    checks.push(['garment_same', `Compare the outfit only, ignoring the pose, the person, the light and the background. Is the ${product} in the PHOTOGRAPH the one in the GARMENT picture - the same colours, the same borders in the same places (along every edge and hem where the GARMENT has them), the same motifs and stone work, and whatever is worn with it (a blouse, a choli) in the same colour${saree ? ' - and worn the same way: the pallu crossing the chest at the same width and with the same folds, over the same shoulder, its decorated end hanging to the same length with its design showing' : ''}?`,
      `The ${product} is exactly the one in the GARMENT REFERENCE: the same colours, the same borders along the same edges and hem, the same motifs and stone work, and whatever is worn with it in its colour - never the customer's own clothes${saree ? '; worn the same way - the pallu across the chest at the same width and with the same folds, over the same shoulder, its decorated end hanging to the same length with all its design showing, not folded into a narrow strip or hidden' : ''}.`]);
    checks.push(['garment_sleeves', 'Look only at the sleeves of the outfit. Does the PHOTOGRAPH have the same sleeves as the GARMENT picture - sleeveless (bare arms from the shoulder) if the GARMENT is sleeveless, otherwise the same length, shape and sleeve ends? Ignore the pose, the person and the background.',
      'THE SLEEVES are exactly as in the GARMENT REFERENCE, not the customer\'s own: if the garment is sleeveless, the arms are bare from the shoulder; otherwise the same sleeve length, shape and sleeve ends.']);
    // Measured 19 Oct: her own red pallu and blouse stayed beside the designed maroon body - two
    // sarees in one. The PERSON photo is sent for this check on the back view too.
    if (review.personPhoto) {
      checks.push(['own_clothes_gone', 'Compare with the PERSON photo. Has every piece of clothing the person wore there been replaced - no part of their own garment, its colour, its pallu, its border, its blouse or its sleeves remaining anywhere in the PHOTOGRAPH - so the outfit is ONE outfit in the GARMENT picture\'s colours from shoulder to hem, not partly in the colour of what they wore?',
        'Nothing of the clothes in the CUSTOMER PHOTO remains: their own garment, its colour, pallu, border, blouse and sleeves are gone entirely, replaced by the GARMENT REFERENCE outfit from the shoulders to the hem, in its colours throughout.']);
    }
  }
  // The most likely way a mannequin photo goes wrong: the image model puts a person in it.
  if (onMannequin) {
    checks.push(['no_person', `Is the ${product} shown on a headless dress-form mannequin, with no person, no head, no face and no hands anywhere in the photograph?`,
      `Show the ${product} on a headless dress-form mannequin on a stand: no person, no head, no face, no hands.`]);
  }
  // Measured 15 Oct: an own-photo front came back with the customer twice, side by side,
  // although the prompt says "exactly one person". A face check passes a copy of the same face.
  // Asked last, so the order of the other checks is unchanged.
  const onePerson = onMannequin ? [] : [['one_person', 'Is there exactly one person in the PHOTOGRAPH - not the same person shown twice side by side, and no second figure, reflection or mannequin?',
    'Show exactly ONE person, once - never the same person twice side by side, and no second figure.']];
  // Measured: with the caller's own photo the image model drew a different face.
  // From behind the face is barely seen, so only a front-facing pose is judged.
  if (review.personPhoto && review.pose !== 'back' && review.view !== 'back') {
    checks.push(['same_face', 'Ignoring the clothes, pose, background and lighting: is the person in the PHOTOGRAPH clearly the same real person as in the PERSON photo - the same face (face shape, eyes, nose, lips), the same skin tone (not lightened) and hair - and not a different or prettified face?',
      'Keep the exact face of the person in the PERSON PHOTO: the same face shape, eyes, eyebrows, nose, lips, skin tone and hair. Do not replace, beautify or re-age the face.']);
  }
  // Measured 13 Oct: looking back over the shoulder, a real customer got a newly drawn face.
  if (review.personPhoto && review.view === 'back') {
    checks.push(['face_hidden', 'Is the person\'s face hidden - only the back of the head and hair seen, with no face, profile or cheek visible?',
      'The head faces straight ahead, away from the camera: only the back of the head and hair are seen - no face, no profile.']);
  }
  // Measured in production: a sheer yoke became solid cloth, a small keyhole back
  // became a deep U. The photograph is compared with the reference picture itself.
  // Measured 15 Oct: with embroidery and zari work layered on (every part had its own design),
  // the pallu, border and body failed for "pearls not in the reference" - pearls added on purpose.
  const layeredNote = (area) => (review.layered && !['EMBROIDERY', 'ZARI_WORK', 'PRINT', 'OVERALL', 'PRINT_PATTERN'].includes(area)
    ? ' Stones, pearls, sequins, beads or zardosi along the edges or as accents come from the separate EMBROIDERY and ZARI_WORK references and are added on purpose - ignore them here, and so is a printed ground pattern from a PRINT reference.' : '');
  for (const r of references) {
    const neck = /NECK|BACK|COLLAR/.test(r.area);
    // Measured: the front reference's own sleeves were compared with the photo's
    // sleeves (which come from the SLEEVE reference) and failed it. Each reference
    // answers for ONE part only.
    checks.push([`ref_${r.area.toLowerCase()}`,
      `REFERENCE ${r.ref} was sent ONLY for the ${r.part}. If it shows a whole garment, every other part of that garment (its sleeves, body, neckline, hem, colour) is NOT part of this reference and must be ignored - those parts of the PHOTOGRAPH follow other references. Ignore the fabric colour too (the garment is made in its own fabric on purpose), and the model and background.${layeredNote(r.area)} Look ONLY at the ${r.part} in the PHOTOGRAPH against the ${r.part} in REFERENCE ${r.ref}. ${neck ? 'Is the neckline the SAME SHAPE, DEPTH and WIDTH as in the reference (not deeper, wider or a different shape), with the same closure (tie-up, keyhole, buttons) at the same size, and ' : 'Are '}the motifs on that part of the same kind, size, spacing and placement, with any sheer or net area of that part still sheer, and any trim, lace, band or edging on that part as in the reference?`,
      `The ${r.part} must follow reference ${r.ref} exactly: ${neck ? 'the same neckline shape, depth and width and the same closure at the same size; ' : ''}the same motifs at the same size, spacing and placement; sheer areas stay sheer; trims and edging as in the reference.`]);
  }
  if (review.view !== 'back') return [...checks, ...onePerson].map(([id, question, correction]) => ({ id, question, correction }));
  checks.push(
    // Measured on a real blouse: teal flowers on the front and gold butis on the back
    // (each side's own reference) were called "different blouses". The decoration is
    // MEANT to differ; only the cloth and the cut must match.
    ['same_garment', `Judge the CLOTH and CUT only - the front and the back carry their own, different designs on purpose, so ignore the embroidery, motifs and decoration entirely. Is the ${product} in the BACK photograph made of the same fabric as in the FRONT photograph (same base colour and shade, same texture and sheen), with the same fit, the same length and the same neckline depth at the shoulders?`,
      `The back view is the same ${product} as the front view in cloth and cut: identical fabric base colour and shade, texture, fit and length. Its decoration follows the back design reference, not the front's.`],
    ['same_sleeves', `Are the sleeves the same in both photographs - the same length, the same shape (puff, fitted, flared), the same fabric and the same sleeve-end finish?`,
      'The sleeves are identical to the front view: same length, shape and sleeve ends.'],
    onMannequin
      ? ['same_mannequin', 'Is it the same mannequin in both photographs - the same headless dress form on the same stand?',
        'The same headless dress form on the same stand as the front view.']
      : ['same_person', 'Is it the same person in both photographs - the same build, skin tone, hair colour and hair style?',
        'The same person as the front view, with the same hair and skin tone.'],
    ['back_shown', `Does the BACK photograph show the back of the ${product} squarely to the camera, with the whole back visible and nothing (hair, hands, ${review.garmentId === 'DUPATTA' ? '' : 'a dupatta, '}a bag) covering any part of it?`,
      `The back of the ${product} faces the camera squarely and is completely visible; hair is pinned up or brought forward, and nothing covers the back.`],
    ['no_front_on_back', `Is it true that the BACK photograph does NOT show the front neckline, front panel or placket of the ${product} (that is, it is not actually a front or three-quarter-front view)?`,
      `The photograph is a true back view: the front of the ${product} is not visible.`],
    ['same_studio', 'Are the backdrop, lighting and framing the same in both photographs?',
      'The same plain studio backdrop, lighting and framing as the front view.']
  );
  if (review.pair) {
    checks.push(['same_supporting', `Is the ${review.pair.pieces} worn with the ${product} the same colour and style in both photographs?`,
      `The ${review.pair.pieces} is the same colour and style as in the front view.`]);
  }
  if (!onMannequin) {
    checks.push(['arms_clear', 'Are the arms hanging at the sides with the hands visible beside the hips - not clasped behind the back, not on the hips, not covering any part of the garment?',
      'The arms hang relaxed at the sides with the hands visible beside the hips; nothing covers the back of the garment.']);
  }
  return [...checks, ...onePerson].filter(([id]) => withFront || !NEEDS_FRONT.has(id)).map(([id, question, correction]) => ({ id, question, correction }));
}
const pairChecklist = (review) => viewChecklist({ ...review, view: 'back' });

/** One call to the inspector model with a JSON answer. Returns { parsed } or { problem }. Throws only on cancel. */
async function askInspector(parts, schema, signal) {
  const timeout = AbortSignal.timeout(config.pair.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchImpl(`${config.gemini.baseUrl}/models/${encodeURIComponent(config.pair.model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey() },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        maxOutputTokens: 2048,
        ...(/2\.5/.test(config.pair.model) ? { thinkingConfig: { thinkingBudget: 0 } } : {})
      }
    }),
    signal: combined
  });
  if (!response.ok) return { problem: `HTTP ${response.status} ${redact(await response.text().catch(() => '')).slice(0, 120)}` };
  const json = await response.json();
  const candidate = (json.candidates || [])[0];
  const answer = ((candidate && candidate.content && candidate.content.parts) || [])
    .filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  try { return { parsed: JSON.parse(answer.replace(/```(?:json)?/gi, '').trim()) }; } catch { return { parsed: null }; }
}

const LABELS_SCHEMA = { type: 'OBJECT', properties: { texts: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['texts'] };
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Edit distance as a share of the longer text: 0 = identical. Tolerates the reader's own small slips. */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length] / Math.max(a.length, b.length, 1);
}

/**
 * Compare the words written on a sketch sheet with the labels it was given.
 * Measured 13 Oct 2026: labels written twice, two labels merged into one, a word dropped -
 * even with the exact words and count in the prompt. Pure comparison, so it is testable.
 * @returns {{ id: string, evidence: string, correction: string }[]}
 */
function labelFailures(expected, found) {
  const texts = found.map(norm).filter((t) => t && !/^(front|back)$/.test(t));
  // Each text counts for its CLOSEST label only. Measured 13 Oct: "Pleat: small floral..." and
  // "Print: small floral..." are 3 letters apart, and each was counted for both.
  const counts = new Map(expected.map((label) => [label, 0]));
  const extras = [];
  for (const t of texts) {
    const [best, d] = expected.map((label) => [label, distance(norm(label), t)]).sort((x, y) => x[1] - y[1])[0] || [null, 1];
    if (d <= 0.1) counts.set(best, counts.get(best) + 1);
    else extras.push({ id: 'label_extra', evidence: `unexpected text "${t}"`, correction: `Remove the text "${t}": write only the listed labels, each exactly as given.` });
  }
  const failures = [];
  for (const [label, n] of counts) {
    if (n === 0) failures.push({ id: 'label_missing', evidence: `"${label}" is not on the sheet as written`, correction: `Write the label "${label}" exactly as given, once.` });
    if (n > 1) failures.push({ id: 'label_repeated', evidence: `"${label}" is written ${n} times`, correction: `Write the label "${label}" ONCE only - never repeat it.` });
  }
  return [...failures, ...extras];
}

/** Read every label on a sketch sheet and compare it with the expected labels. Never required. */
async function reviewLabels(expected, image, { signal } = {}) {
  const started = Date.now();
  const unchecked = (problem) => ({ checked: false, failures: [], problem, ms: Date.now() - started });
  if (!config.pair.enabled || !config.gemini.apiKey() || !expected.length) return unchecked('disabled');
  const parts = [
    { text: 'Read every piece of text written on this fashion illustration sheet, exactly as written (keep spelling mistakes). Give one entry per label: a label written over several lines is ONE entry, its lines joined with a space. A label written twice is two entries. Include captions such as FRONT and BACK.' },
    { inlineData: { mimeType: image.mimeType, data: image.base64 } }
  ];
  try {
    const asked = await askInspector(parts, LABELS_SCHEMA, signal);
    if (asked.problem) return unchecked(asked.problem);
    if (!asked.parsed || !Array.isArray(asked.parsed.texts)) return unchecked('answer was not usable JSON');
    return { checked: true, failures: labelFailures(expected, asked.parsed.texts), ms: Date.now() - started };
  } catch (err) {
    if (signal && signal.aborted) throw err;
    return unchecked(redact(err && err.message));
  }
}

/**
 * Compare a back photograph with the front photograph it was made from.
 * Same shape of answer as reviewImage. Never required.
 */
async function reviewView(review, { image, frontImage = null, garmentImage = null, references = [], signal } = {}) {
  const started = Date.now();
  const checklist = viewChecklist(review, references, { withFront: !!frontImage, withGarment: !!garmentImage });
  const unchecked = (problem) => ({ checked: false, failures: [], problem, ms: Date.now() - started });
  if (!config.pair.enabled || !config.gemini.apiKey() || !checklist.length) return unchecked('disabled');
  const isBack = review.view === 'back' && frontImage;
  const text = [
    `You are the quality inspector for a fashion catalogue. The PHOTOGRAPH is the ${review.view || 'front'} view of a ${review.product} on ${review.presentation === 'mannequin' ? 'a headless dress-form mannequin' : 'a model'}. The REFERENCE pictures are the customer's design references that the ${review.product} was made from${isBack ? '; the FRONT picture is the front view of the same garment, already approved' : ''}${garmentImage ? '; the GARMENT picture is the finished garment, on a mannequin, that the person must be wearing' : ''}${checklist.some((c) => c.id === 'same_face') ? '; the PERSON picture is the real customer who must be the one wearing it' : ''}.`,
    'Answer each check strictly: pass=true only when it is clearly satisfied. When something differs, answer pass=false and say what differs in evidence (under 25 words).',
    'Answer every check, using its id.',
    '',
    ...checklist.map((c) => `- ${c.id}: ${c.question}`)
  ].join('\n');
  const parts = [{ text }, { text: 'PHOTOGRAPH:' }, { inlineData: { mimeType: image.mimeType, data: image.base64 } }];
  for (const r of references) parts.push({ text: `REFERENCE ${r.ref} (${r.part}):` }, { inlineData: { mimeType: r.image.mimeType, data: r.image.base64 } });
  if (isBack) parts.push({ text: 'FRONT view:' }, { inlineData: { mimeType: frontImage.mimeType, data: frontImage.base64 } });
  if (garmentImage) parts.push({ text: 'GARMENT picture:' }, { inlineData: { mimeType: garmentImage.mimeType, data: garmentImage.base64 } });
  if (checklist.some((c) => c.id === 'same_face' || c.id === 'own_clothes_gone')) parts.push({ text: 'PERSON photo:' }, { inlineData: { mimeType: review.personPhoto.mimeType, data: review.personPhoto.base64 } });
  try {
    const asked = await askInspector(parts, RESPONSE_SCHEMA, signal);
    if (asked.problem) return unchecked(asked.problem);
    const parsed = asked.parsed;
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

/** Kept for callers of the older name: the back view against the front photograph only. */
const reviewPair = (review, frontImage, backImage, opts = {}) => reviewView({ ...review, view: 'back' }, { image: backImage, frontImage, ...opts });

module.exports = { reviewImage, reviewView, reviewLabels, labelFailures, viewChecklist, reviewPair, pairChecklist, buildChecklist, correctionsText, sameColourFamily, RESPONSE_SCHEMA, _setFetch: (fn) => { fetchImpl = fn; } };
