// =============================================================================
// parts/back.js — the back, made by the AI from the front, when no photo shows it.
// =============================================================================
//
// Owner, 19 Nov 2026: "when no back we will gen and give; if they sent [a back photo], ok". A back
// photo is cut like every other part. Without one the back is not known, so it is MADE: the same
// garment seen from behind - its fabric, print, colours, sleeves and trims from the front - with a
// plain, classic back. It is marked in the RESULT (generated: true and a message), never on the
// picture (owner: "in result need to mark, not on img"). It never adds a back design the front
// does not show: a tailor must not stitch an invention.

const sharp = require('sharp');
const { config } = require('../config');
const { StudioError } = require('../errors');
const { generateImage } = require('../geminiImage');
const { askInspector } = require('../qualityCheck');

/** The part can be made from the front: a garment's BACK. */
const canMakeBack = (areaId) => areaId === 'BACK';

const MESSAGE = 'Made by AI from the front: the back was not in your photo, so its design is a guess. Check it before keeping, or send a photo of the back.';

async function frontReference(photo) {
  const data = await sharp(Buffer.from(photo.image.base64, 'base64'))
    .resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
  return { mimeType: 'image/jpeg', base64: data.toString('base64') };
}

function backParts(job, front) {
  const g = job.product;
  const text = [
    `This photo shows a ${g}${job.productName ? ` ("${job.productName}")` : ''} from the FRONT. Its back is not in the photo. Make a photograph of the BACK of this same ${g}, worn the same way by the same person: a close-up of the back, seen from directly behind, the head turned away (no face), the hair moved over one shoulder so the whole back of the ${g} shows.`,
    '',
    'THE SAME GARMENT: the same fabric, weave and print as the front, in exactly the same colours - the same motifs at the same size and spacing; the same sleeves with the same borders or cuffs; the same piping, borders and trims, in the same colours.',
    'THE BACK DESIGN IS NOT KNOWN, so it is plain and classic: the back panel in the same fabric as the front, a simple back neckline finished with the same piping or edging as the front neckline, and the same hem. Add NO embroidery, motif, cut-out, keyhole, tie, tassel, latkan or button that the front does not show.',
    '',
    'QUALITY: a real photograph in the same light and setting as the front photo, crisp fabric texture, natural folds. No text, label, watermark or frame anywhere in the picture. Exactly one photograph.'
  ].join('\n');
  return [{ text }, { inlineData: { mimeType: front.mimeType, data: front.base64 } }];
}

const CHECKS = [
  ['same_fabric', 'The BACK is the same fabric with the same print or weave as the FRONT, its motifs at the same size and spacing.'],
  ['same_colours', 'The same colours as the FRONT: fabric, print, piping and borders.'],
  ['same_sleeves', 'The sleeves have the same length, borders or cuffs as on the FRONT.'],
  ['nothing_new', 'The back adds no embroidery, motif, cut-out, keyhole, tie, tassel, latkan or button that the FRONT does not show.'],
  ['back_view', 'It shows the back of the garment, seen from behind, with no face.']
];
const SCHEMA = {
  type: 'OBJECT',
  properties: { ...Object.fromEntries(CHECKS.map(([id]) => [id, { type: 'BOOLEAN' }])), evidence: { type: 'STRING' } },
  required: [...CHECKS.map(([id]) => id), 'evidence'],
  propertyOrdering: [...CHECKS.map(([id]) => id), 'evidence']
};

async function checkBack(front, back, signal) {
  try {
    const { parsed } = await askInspector([
      { text: 'FRONT - a real photo of a garment:' },
      { inlineData: { mimeType: front.mimeType, data: front.base64 } },
      { text: 'BACK - meant to be the same garment seen from behind (its back design was not known, so it should be plain):' },
      { inlineData: { mimeType: back.mimeType, data: back.base64 } },
      { text: `Judge as a strict tailor.\n${CHECKS.map(([id, q]) => `${id}: ${q}`).join('\n')}\nevidence: one short sentence naming the difference that matters most, or "none".` }
    ], SCHEMA, signal);
    if (!parsed) return { checked: false, failures: [] };
    const evidence = typeof parsed.evidence === 'string' ? parsed.evidence.slice(0, 300) : '';
    return { checked: true, failures: CHECKS.filter(([id]) => parsed[id] === false).map(([id]) => ({ check: id, evidence })) };
  } catch (err) {
    if (signal && signal.aborted) throw err;
    return { checked: false, failures: [] };
  }
}

/**
 * @returns {Promise<{ image, attempts, quality }>}  @throws StudioError from the image model
 */
async function makeBackFromFront(job, photo, { signal } = {}) {
  const front = await frontReference(photo);
  const parts = backParts(job, front);
  const make = (extra) => generateImage(extra ? [...parts, { text: extra }] : parts, {
    signal, imageSize: config.parts.imageSize, aspectRatio: '3:4',
    attemptTimeoutMs: config.parts.attemptTimeoutMs, timeoutRetries: config.parts.timeoutRetries
  });
  let result = await make();
  let attempts = result.attempts;
  let verdict = config.pair.enabled ? await checkBack(front, result.image, signal) : { checked: false, failures: [] };
  let regenerated = false;
  if (verdict.failures.length && config.parts.maxRegenerations > 0) {
    try {
      const retry = await make(`THE LAST ATTEMPT WAS WRONG: ${verdict.failures[0].evidence || verdict.failures.map((f) => f.check).join(', ')}. Make it again: the same garment as the front, seen from behind, with a plain back.`);
      attempts += retry.attempts;
      regenerated = true;
      const second = await checkBack(front, retry.image, signal);
      if (!second.checked || second.failures.length <= verdict.failures.length) { result = retry; verdict = second; }
    } catch (err) {
      if ((err instanceof StudioError && err.code === 'CANCELLED') || (signal && signal.aborted)) throw err;
    }
  }
  return {
    image: result.image,
    attempts,
    quality: { checked: verdict.checked, passed: verdict.checked ? verdict.failures.length === 0 : null, failures: verdict.failures, regenerated }
  };
}

module.exports = { makeBackFromFront, canMakeBack, backParts, MESSAGE, CHECKS };
