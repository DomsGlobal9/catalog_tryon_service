// =============================================================================
// parts/enhance.js — the cut part made into a sharp close-up, checked, and made once more if it changed.
// =============================================================================
//
// Measured 19 Nov 2026 (four real photos, 2K): a saree border, a zardosi cuff and a blouse neckline
// came back much sharper and the same design. A kurti neckline cut at 174 px came back with its
// round dots turned into small flowers and a stitched notch added: from so little the model
// guesses. So every close-up is compared with the cut it came from; a changed design, colour, or an
// added or missing detail is made once more with the fault named, and the better of the two kept.
// A small cut is also reported (lowDetail), so the boutique looks twice before keeping it.

const { config } = require('../config');
const { StudioError } = require('../errors');
const { generateImage } = require('../geminiImage');
const { askInspector } = require('../qualityCheck');
const { partWhere } = require('./describe');

function enhanceParts(job, part, cut) {
  const name = part.name.toLowerCase();
  const where = partWhere(job.garmentId, part.areaId);
  const text = [
    `This picture is a piece cut from a photo of a ${job.product}${job.productName ? ` ("${job.productName}")` : ''}: its ${name} (${where}). Make it into a sharp, high-resolution close-up photograph of exactly this - as if a professional photographer had taken a macro shot of the same ${name} with a better camera, from the same angle.`,
    ...(part.note ? [`The boutique's note on this part: ${part.note}`] : []),
    '',
    'FIDELITY - THE HIGHEST PRIORITY: this is the record a tailor will stitch from, so it must be the same garment, never a new design.',
    '- Every motif, border, line of piping and pattern repeat stays exactly where it is: the same shapes, the same number, the same spacing, the same size relative to the part.',
    '- The same colours: the fabric and every thread, zari, bead, sequin and stone keep their exact hue and brightness. Nothing is recoloured, brightened into a new shade or made more saturated.',
    '- The same materials and work: woven stays woven, embroidery stays embroidery with its stitches, a print stays a print; zari has its metallic thread, sequins and stones their sparkle.',
    '- Nothing is added and nothing is removed: no new motif, border, trim, piping, seam, button, tassel or embellishment, and nothing that is there is left out. Small dots stay dots; plain fabric stays plain.',
    '- Where the picture is blurry, sharpen what is there, continuing the pattern exactly as it repeats in the clearer places. Never invent a detail that the picture does not suggest.',
    // Measured 19 Nov in production: blurry red ikat flowers on a blouse came back as small parrots.
    '- A shape never becomes a recognisable figure it is not clearly in the picture: no bird, animal, face, peacock, elephant, flower or leaf appears where the picture shows only a blot, a dash or an abstract shape. Ikat, block-print and woven blurs stay the same soft abstract shapes, only crisper.',
    ...(cut.lowDetail ? ['- THIS PIECE IS SMALL AND BLURRY: sharpen edges and fabric texture only. Keep every motif exactly as simple as it appears - its outline, size and colour - and add no fine detail inside it.'] : []),
    '',
    'THE SAME FRAME: keep the framing, the angle, the folds and the drape as they are. Whatever else is in the picture (skin, hair, hands, jewellery, background) stays where it is and as it is, only sharper - nothing is removed or added, no person is restyled.',
    '',
    'QUALITY: crisp focus on the fabric, the fine texture of the weave and the work visible, natural soft light, no blur, no noise, no watermark, no text, no frame. Produce exactly one photograph.'
  ].join('\n');
  return [{ text }, { inlineData: { mimeType: cut.image.mimeType, data: cut.image.base64 } }];
}

// Framing and sharpness are reported but never a reason to make it again: only what a tailor
// would stitch differently is.
const CHECKS = [
  ['same_design', 'Every motif, border and pattern of the ORIGINAL is in the CLOSE-UP with the same shapes, count and placement.'],
  ['same_colours', 'The fabric and the work are in the same hue and brightness.'],
  ['nothing_added', 'No motif, trim, piping, seam, border or embellishment that the ORIGINAL does not have.'],
  ['nothing_removed', 'Nothing of the ORIGINAL is left out.'],
  // The parrot case (19 Nov): every motif was "there", so same_design passed - but as a new figure.
  ['no_new_figures', 'No motif has become a recognisable figure (a bird, animal, face, flower or leaf) that it is not clearly in the ORIGINAL; abstract or blurry shapes stay abstract.']
];
const CHECK_SCHEMA = {
  type: 'OBJECT',
  properties: { ...Object.fromEntries(CHECKS.map(([id]) => [id, { type: 'BOOLEAN' }])), evidence: { type: 'STRING' } },
  required: [...CHECKS.map(([id]) => id), 'evidence'],
  propertyOrdering: [...CHECKS.map(([id]) => id), 'evidence']
};

/** @returns {Promise<{ checked: boolean, failures: {check, evidence}[] }>} never throws unless cancelled */
async function checkCloseUp(cut, closeUp, { signal } = {}) {
  try {
    const { parsed } = await askInspector([
      { text: 'ORIGINAL - a piece cut from a real photo of a garment:' },
      { inlineData: { mimeType: cut.image.mimeType, data: cut.image.base64 } },
      { text: 'CLOSE-UP - meant to be the same thing, only sharper:' },
      { inlineData: { mimeType: closeUp.mimeType, data: closeUp.base64 } },
      // Measured 19 Nov (13 real parts): most "failures" were the frame - "shows more of the sari", "the
      // pant is missing" - and each cost a second image. Only the garment's design counts.
      { text: `Compare them as a strict tailor would, judging ONLY the garment's design inside the part. Being sharper is expected. The CLOSE-UP may also show a little more or a little less around the edges, or a person or background slightly differently - that is framing and does NOT count as added or removed. Count only a change a tailor would stitch differently: a motif changed in shape, number or placement, a colour changed, or trim, piping, border or work that was added or left out.\n${CHECKS.map(([id, q]) => `${id}: ${q}`).join('\n')}\nevidence: one short sentence naming the design difference that matters most, or "none".` }
    ], CHECK_SCHEMA, signal);
    if (!parsed) return { checked: false, failures: [] };
    const evidence = typeof parsed.evidence === 'string' ? parsed.evidence.slice(0, 300) : '';
    return { checked: true, failures: CHECKS.filter(([id]) => parsed[id] === false).map(([id]) => ({ check: id, evidence })) };
  } catch (err) {
    if (signal && signal.aborted) throw err;
    return { checked: false, failures: [] };
  }
}

/**
 * @returns {Promise<{ image: Object, attempts: number, usage: Object|null, quality: Object }>}
 * @throws StudioError from the image model (the caller falls back to the plain cut)
 */
async function enhancePart(job, part, cut, { signal, onAttempt } = {}) {
  const parts = enhanceParts(job, part, cut);
  const make = (extra) => generateImage(extra ? [...parts, { text: extra }] : parts, {
    signal, onAttempt, imageSize: config.parts.imageSize, aspectRatio: cut.aspectRatio
  });
  let result = await make();
  let attempts = result.attempts;
  let verdict = config.pair.enabled ? await checkCloseUp(cut, result.image, { signal }) : { checked: false, failures: [] };
  let regenerated = false;
  for (let round = 0; verdict.failures.length && round < config.parts.maxRegenerations; round++) {
    try {
      const retry = await make(`THE LAST ATTEMPT CHANGED THE GARMENT: ${verdict.failures[0].evidence || verdict.failures.map((f) => f.check).join(', ')}. Make it again, keeping exactly what the picture shows - only sharper.`);
      attempts += retry.attempts;
      regenerated = true;
      const second = await checkCloseUp(cut, retry.image, { signal });
      if (!second.checked || second.failures.length <= verdict.failures.length) { result = retry; verdict = second; }
    } catch (err) {
      if (err instanceof StudioError && err.code === 'CANCELLED') throw err;
      if (signal && signal.aborted) throw err;
      break; // the first close-up stands
    }
  }
  return {
    image: result.image,
    attempts,
    usage: result.usage,
    quality: { checked: verdict.checked, passed: verdict.checked ? verdict.failures.length === 0 : null, failures: verdict.failures, regenerated }
  };
}

module.exports = { enhancePart, enhanceParts, checkCloseUp, CHECKS };
