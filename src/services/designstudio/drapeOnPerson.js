// =============================================================================
// drapeOnPerson.js — the second step for a caller's own photo (since 19 Oct 2026).
// =============================================================================
//
// Measured 19 Oct on a real request: a narrow customer photo (379x1172, about 1:3)
// was made into a 3:4 photograph; to fill the wider frame the image model invented
// the room around her and redrew her face, hair and pose. So an own photo now goes
// the Try-On way: the garment is first made on a mannequin (with all the design
// checks), then draped onto the photo, which keeps its own frame:
//   - the photo is padded with flat grey bands to the nearest shape the image model
//     can make, and the result is cut back to exactly the photo's area, so nothing
//     the model invents around the photo can reach the caller;
//   - the instructions are Try-On's (tryon/backend/prompts.js): who to dress, the
//     identity lock, the garment and colour lock, the scene lock.

const sharp = require('sharp');
const { garmentGuide } = require('./garmentGuide');

// The shapes the image model can make, as width / height.
const RATIOS = [['21:9', 21 / 9], ['16:9', 16 / 9], ['3:2', 3 / 2], ['4:3', 4 / 3], ['5:4', 5 / 4], ['1:1', 1],
  ['4:5', 4 / 5], ['3:4', 3 / 4], ['2:3', 2 / 3], ['9:16', 9 / 16]];
const PAD = { r: 128, g: 128, b: 128 };

/**
 * Pad the photo to the shape that needs the least padding.
 * @returns {Promise<{ image: Object, aspectRatio: string, padded: boolean, cutBack: (out: Object) => Promise<Object> }>}
 */
async function framePerson(photo) {
  const input = Buffer.from(photo.base64, 'base64');
  const { width: W, height: H } = await sharp(input).metadata();
  const ratio = W / H;
  const [aspectRatio, r] = RATIOS
    .map(([name, x]) => [name, x, x >= ratio ? H * H * x : (W * W) / x]) // padded area
    .sort((a, b) => a[2] - b[2])[0];
  const padW = r >= ratio ? Math.round(H * r) : W;
  const padH = r >= ratio ? H : Math.round(W / r);
  const left = Math.floor((padW - W) / 2);
  const top = Math.floor((padH - H) / 2);
  const padded = left > 0 || top > 0;
  const data = await sharp(input)
    .extend({ left, right: padW - W - left, top, bottom: padH - H - top, background: PAD })
    .jpeg({ quality: 95 })
    .toBuffer();

  // The result is cut back to exactly the photo's area, at the result's own scale.
  const cutBack = async (out) => {
    const buf = Buffer.from(out.base64, 'base64');
    const { width: ow, height: oh } = await sharp(buf).metadata();
    const sx = ow / padW;
    const sy = oh / padH;
    const box = {
      left: Math.min(ow - 1, Math.round(left * sx)),
      top: Math.min(oh - 1, Math.round(top * sy))
    };
    box.width = Math.max(1, Math.min(ow - box.left, Math.round(W * sx)));
    box.height = Math.max(1, Math.min(oh - box.top, Math.round(H * sy)));
    const { data: cut, info } = await sharp(buf).extract(box).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
    return { mimeType: 'image/jpeg', base64: cut.toString('base64'), width: info.width, height: info.height, bytes: cut.length };
  };

  return { image: { mimeType: 'image/jpeg', base64: data.toString('base64') }, aspectRatio, padded, cutBack };
}

// Try-On's per-garment drape rules (tryon/backend/prompts.js CATEGORY_PROMPTS), worded for
// a garment that is already made: the reference is the finished garment on a mannequin.
const GARMENT_RULES = {
  // Measured 19 Oct: the front view kept the customer's OWN drape - her pallu folded into a narrow
  // strip across the chest and a short end at her side - not the designed saree's.
  SAREE: 'THE SAREE is worn exactly as on the GARMENT REFERENCE, never the way the customer\'s own saree was draped: the pallu crosses the chest at the same width and with the same folds as there, goes over the same shoulder, and its decorated end hangs to the same length with all of its design showing - never folded into a narrow strip, shortened, tucked away or hidden behind an arm or another person. The border runs exactly where it does on the reference - along the pallu\'s edges and right round the hem - in front and at the back. The blouse is the reference\'s blouse in its colour and cut, never the customer\'s own. Every pleat at the waist crisp, the wrapping pattern round the body as in the reference. The pallu stops exactly at its border: no plain fabric hanging below it and no train on the floor.',
  LEHANGA: 'THE LEHENGA SET: keep the exact volume, flare and pleating of the skirt with its borders and embroidery, and the exact cut, neckline and sleeves of the choli. A dupatta only if the reference shows one, draped exactly as there.',
  ANARKALI: 'THE ANARKALI: keep the long, frock-style flare from the waist down with its exact volume and weight, the fitted bodice, neckline and sleeves, and the bottoms as shown. A dupatta only if the reference shows one.',
  SHARARA: 'THE SHARARA SUIT: keep the wide, flared, ruffled pants from the knee down, and the exact length, side slits and neckline of the top. A dupatta only if the reference shows one.',
  KURTHI: 'THE KURTI: keep the exact length, side slits, neckline and sleeves, and the bottoms as shown. A dupatta only if the reference shows one.'
};
const DEFAULT_RULE = 'THE OUTFIT: keep the exact silhouette, neckline, sleeves and skirt or pant structure. A dupatta only if the reference shows one.';

/** The parts for the drape call: the instructions, the finished garment, then the customer's photo last. */
function drapeParts(job, view, garment, framed) {
  const g = garmentGuide(job.garmentId);
  const wearer = (job.model.gender || g.wearer) === 'male' ? 'man' : 'woman';
  const text = [
    `You are a professional fashion photographer conducting a virtual fitting session for Indian ethnic wear. The customer put on the ${g.product} shown in the GARMENT REFERENCE. Your job is to photograph them wearing it - nothing else changes about the person or the photo.`,
    ...(framed.padded ? ['', 'THE FRAME: the CUSTOMER PHOTO has flat grey bands at its edges. They are padding, not part of the scene: leave them flat grey and untouched. Do not extend, widen, re-frame, zoom or crop the photo - everything stays exactly where it is in the frame.'] : []),
    '',
    `RULE #0 - WHO TO DRESS: the photo may show more than one person, or part of one at an edge. Dress EXACTLY ONE person: if there is one person, that person; otherwise the most prominent ${wearer} (the largest in the frame). Everyone else, and any part of a person at an edge, stays EXACTLY as they are - same face, clothes, pose and position.`,
    '',
    'RULE #1 - ABSOLUTE IDENTITY LOCK (HIGHEST PRIORITY - OVERRIDES ALL OTHER INSTRUCTIONS): the customer\'s face is forensic evidence and must not be altered in any way. Same expression - no added or changed smile, no more "photogenic" look. Same bone structure, jawline, cheek contour, nose, eyes, eyelids, eyebrows and lips; same skin texture with its pores and marks, no smoothing or airbrushing; same makeup and small jewellery. Same body shape, proportions, weight and posture - the outfit conforms to their body, never the body to the outfit. Same skin tone everywhere - no lightening, no darkening. Same hairstyle, volume, parting, colour and loose strands.',
    '',
    `RULE #2 - THE GARMENT AND STRICT ISOLATION: take ONLY the garment from the GARMENT REFERENCE - ignore the mannequin, its stand and the studio. Reproduce every detail exactly: every border, panel, motif, print and embroidery, and all stone, pearl, sequin and zardosi work, at the same scale and in the same places. COLOUR LOCK: the garment's colours match the reference exactly - same hue, same saturation, same brightness of the dye; the scene's light only shades the folds and never tints the fabric.`,
    GARMENT_RULES[job.garmentId] || DEFAULT_RULE,
    // Measured 19 Oct (second prod run): the back view grew a gold embroidered motif on the plain teal blouse.
    'Whatever is worn with the garment in the reference (a blouse, a choli, bottoms) is worn exactly as there: the same colour, and plain where the reference\'s is plain - no embroidery, motif, border or trim is added to it, front or back. Nothing of the customer\'s own outfit shows.',
    // Measured 19 Oct: her own red saree's pallu and blouse stayed in the photo beside the designed
    // maroon body, so the result was two sarees in one - half her colour, half the reference's.
    'THE CUSTOMER\'S OWN CLOTHES ARE REPLACED ENTIRELY, from the shoulders to the hem: not their colour, their pallu, their border, their blouse or their sleeves remains anywhere. The outfit in the photograph is ONE outfit, in the GARMENT REFERENCE\'s colours throughout - never partly in the colour of what the customer was wearing.',
    // Measured 19 Oct in production: the customer's own elbow-length blouse sleeves stayed on
    // the front view while the reference blouse (and the back view) was sleeveless.
    'THE SLEEVES come from the GARMENT REFERENCE, never from the customer\'s own clothes: where the reference is sleeveless, the customer\'s arms are bare from the shoulder; where it has sleeves, they have exactly its length, shape and sleeve ends.',
    ...(view === 'back' ? ['', `THIS IS THE BACK VIEW: the GARMENT REFERENCE shows the back of the ${g.product}. Show the same customer in the same spot of the same scene, turned round so their back faces the camera, the head facing straight ahead, away from the camera: only the back of the head and their own hair are seen - no face, no profile. The back of the ${g.product} is exactly as in the reference.`] : []),
    '',
    'RULE #3 - THE SCENE LOCK: keep the customer photo\'s background, walls, floor, furniture, objects and lighting identical. Nothing from the garment reference\'s studio appears. Add nothing to the scene: no new shadows, light patterns, plants, props or objects.',
    '',
    'RULE #4 - QUALITY: indistinguishable from a real, unretouched photograph: natural skin texture, no beauty filter, the fabric with real weight, folds and fine wrinkles.',
    '',
    'RULE #5 - ANATOMY: the customer, and everyone else in the photo, has exactly two arms and two hands with five fingers each; the fabric flows round the hands naturally. Exactly one copy of the customer.',
    '',
    'Produce exactly one final photograph.'
  ].join('\n');
  return [
    { text },
    { text: 'GARMENT REFERENCE - the finished garment to wear:' },
    { inlineData: { mimeType: garment.mimeType, data: garment.base64 } },
    { text: 'CUSTOMER PHOTO - dress the customer as Rule #0 describes; keep everything else exactly:' },
    { inlineData: { mimeType: framed.image.mimeType, data: framed.image.base64 } }
  ];
}

module.exports = { framePerson, drapeParts, RATIOS };
