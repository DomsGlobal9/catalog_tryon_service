// =============================================================================
// productShots - product photos of a saree (folded, table scene), no model, each in a random setting.
// =============================================================================
//
// Asked for with "productShots": true on the women catalog request (sarees only, owner 26 Nov 2026).
// Made after the front view, side by side with the side and sitting views, from:
//   - the saree's own photo (the truth for design, colours and border),
//   - the blouse photo when one was sent,
//   - the finished front view (how this saree's border and pallu look when worn).
// Each shot is checked against the saree's photo (same design, colours, border, nothing added, no
// person) and made once more when the check finds a difference. A shot that fails is reported on
// its own; it never takes the three model views down with it.

const { SHOTS, pickPlace } = require('./settings');
// Loaded when a shot is made, not at start-up: the Design Studio settings are read from the
// environment once, on first load, and must not be read early by the catalog route.
const studio = () => ({ config: require('../designstudio/config').config, askInspector: require('../designstudio/qualityCheck').askInspector });
const { stepLog, withContext, secondsSince } = require('../../lib/stepLog');

const splitDataUri = (img) => {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(img || ''));
  return m ? { mimeType: m[1], data: m[2] } : { mimeType: 'image/jpeg', data: String(img || '') };
};
const inline = (img) => { const { mimeType, data } = splitDataUri(img); return { inline_data: { mime_type: mimeType, data } }; };

function shotPrompt(shot, place, { hasBlouse }) {
  return [
    'You are a product photographer for an Indian saree shop. Make ONE product photograph of the saree in the reference photos. There is NO person, NO model, NO mannequin and NO hands anywhere in the picture: the saree alone.',
    '',
    shot.scene,
    `THE SETTING: ${place}. Choose the exact tones of the setting so they flatter the saree: never the saree's own main colour, so the saree stands out clearly.`,
    hasBlouse ? 'The blouse piece from the BLOUSE photo lies neatly folded beside the saree, small, its fabric showing.' : '',
    '',
    'THE SAREE MUST BE EXACTLY THE SAME SAREE: the same base colour, the same motifs at the same size, shape and spacing, the same border with the same width, colours and pattern, the same pallu design, the same zari. The saree has three zones and each keeps its own pattern wherever it shows: the BODY (the main field), the BORDER and the PALLU - never put a generic pattern where the own pattern of this saree belongs. Do not add, remove, simplify or invent any motif, figure, stripe, check or border. Where the SAREE photo does not show a part clearly, use the FRONT VIEW photo for how it looks.',
    '',
    'QUALITY: a real, high-end product photograph - crisp fabric texture, real folds and soft natural shadows, true colours, sharp focus on the saree. No text, logo, label, watermark, price tag or frame anywhere. Exactly one photograph.'
  ].filter((line) => line !== null).join('\n');
}

function shotParts(shot, place, refs) {
  const parts = [{ text: shotPrompt(shot, place, { hasBlouse: !!refs.blouse }) }];
  parts.push({ text: 'SAREE - the real saree (the truth for its design, colours and border):' }, inline(refs.saree));
  if (refs.blouse) parts.push({ text: 'BLOUSE - the blouse piece sold with it:' }, inline(refs.blouse));
  if (refs.front) parts.push({ text: 'FRONT VIEW - the same saree worn by a model (only to see its border and pallu; draw no person):' }, inline(refs.front));
  return parts;
}

const CHECKS = [
  ['same_design', 'The saree in the PRODUCT PHOTO has the same motifs as the SAREE photo - the same shapes at the same size and spacing.'],
  ['same_colours', 'The same base colour and the same colours of motifs, border and zari as the SAREE photo.'],
  ['same_border', 'The same border: the same width, pattern and colours.'],
  ['nothing_added', 'No motif, figure, stripe or border appears on the saree that the SAREE photo does not show.'],
  ['no_person', 'There is no person, face, hand or mannequin, and no text, logo or watermark in the PRODUCT PHOTO.']
];
const SCHEMA = {
  type: 'OBJECT',
  properties: { ...Object.fromEntries(CHECKS.map(([id]) => [id, { type: 'BOOLEAN' }])), evidence: { type: 'STRING' } },
  required: [...CHECKS.map(([id]) => id), 'evidence'],
  propertyOrdering: [...CHECKS.map(([id]) => id), 'evidence']
};

async function checkShot(refs, image, signal) {
  try {
    const toPart = (img) => { const { mimeType, data } = splitDataUri(img); return { inlineData: { mimeType, data } }; };
    const { parsed } = await studio().askInspector([
      { text: 'SAREE - a real photo of a saree:' }, toPart(refs.saree),
      { text: 'PRODUCT PHOTO - meant to show this same saree, folded or arranged, with no person. Its arrangement and background are free; only the saree itself must match:' }, toPart(image),
      { text: `Judge as a strict saree seller; framing, folding and background do not count.\n${CHECKS.map(([id, q]) => `${id}: ${q}`).join('\n')}\nevidence: one short sentence naming the difference that matters most, or "none".` }
    ], SCHEMA, signal);
    if (!parsed) return { checked: false, failures: [] };
    const evidence = typeof parsed.evidence === 'string' ? parsed.evidence.slice(0, 300) : '';
    return { checked: true, failures: CHECKS.filter(([id]) => parsed[id] === false).map(([id]) => ({ check: id, evidence })) };
  } catch (err) {
    if (signal && signal.aborted) throw err;
    return { checked: false, failures: [] };
  }
}

const isCancel = (err, signal) => (signal && signal.aborted) || /AbortError/.test(String((err && err.message) || err));

/**
 * One shot: made, checked, made once more when the check finds a difference (the better of the two
 * is kept). Throws only on cancel; any other failure comes back as { error }.
 */
async function makeShot(shot, refs, { generate, signal, random } = {}) {
  const place = pickPlace(shot, random);
  const started = Date.now();
  const parts = shotParts(shot, place, refs);
  try {
    let image = await generate(parts, signal);
    let verdict = studio().config.pair.enabled ? await checkShot(refs, image, signal) : { checked: false, failures: [] };
    let regenerated = false;
    if (verdict.failures.length) {
      try {
        const again = await generate([...parts, { text: `THE LAST ATTEMPT WAS WRONG: ${verdict.failures[0].evidence || verdict.failures.map((f) => f.check).join(', ')}. Make it again with the saree exactly as in the SAREE photo.` }], signal);
        regenerated = true;
        const second = await checkShot(refs, again, signal);
        if (!second.checked || second.failures.length <= verdict.failures.length) { image = again; verdict = second; }
      } catch (err) {
        if (isCancel(err, signal)) throw err;
      }
    }
    const checkPassed = verdict.checked ? verdict.failures.length === 0 : null;
    stepLog('Catalog', { endpoint: 'women', item: `shot ${shot.id}`, result: 'made', seconds: secondsSince(started), check: checkPassed === null ? 'not checked' : checkPassed ? 'passed' : `still differs: ${verdict.failures.map((f) => f.check).join(', ')}`, setting: place.slice(0, 60) });
    return { shot: shot.id, name: shot.name, setting: place, image, checkPassed, regenerated, ...(checkPassed === false ? { differences: verdict.failures.map((f) => f.check) } : {}) };
  } catch (err) {
    if (isCancel(err, signal)) throw err;
    const limit = err && err.code === 'PROVIDER_LIMIT_REACHED';
    stepLog('Catalog', { endpoint: 'women', item: `shot ${shot.id}`, result: 'failed', seconds: secondsSince(started), why: String((err && err.message) || err).slice(0, 140) });
    return {
      shot: shot.id,
      name: shot.name,
      error: {
        code: limit ? 'AI_LIMIT_REACHED' : 'PRODUCT_SHOT_FAILED',
        message: limit ? 'The AI service hit its usage limit; this product shot was not made. Try again in a few minutes.' : 'This product shot could not be made just now. The model views are not affected.',
        retryable: true
      }
    };
  }
}

/**
 * All shots side by side. `onShot` fires as each one lands (made or failed).
 * @returns {Promise<Array>} one result per shot, in SHOTS order
 */
async function makeProductShots(refs, { generate, onShot, signal, random } = {}) {
  return Promise.all(SHOTS.map((shot) => withContext({ item: `shot ${shot.id}` }, async () => {
    const out = await makeShot(shot, refs, { generate, signal, random });
    if (onShot) onShot(out);
    return out;
  })));
}

module.exports = { SHOT_COUNT: SHOTS.length, makeProductShots, makeShot, shotPrompt, shotParts, checkShot, CHECKS };
