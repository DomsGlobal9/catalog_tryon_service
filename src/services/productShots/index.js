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

function shotPrompt(shot, place, { hasBlouse, extras = 0 }) {
  return [
    'You are a product photographer for an Indian saree shop. Make ONE product photograph of the saree in the reference photos. There is NO person, NO model, NO mannequin and NO hands anywhere in the picture: the saree alone.',
    '',
    shot.scene,
    shot.lightOnly
      ? `THE LIGHT: ${place}. Keep the true colours of the saree in this light.`
      : `THE SETTING: ${place}. Choose the exact tones of the setting so they flatter the saree: never the saree's own main colour, so the saree stands out clearly.`,
    extras ? `The ${extras === 1 ? 'SAREE DETAIL photo shows' : 'SAREE DETAIL photos show'} more of the SAME saree (its pallu, border or a close-up): copy the pallu and border from ${extras === 1 ? 'it' : 'them'} exactly, never guess them.` : '',
    hasBlouse && !shot.lightOnly ?'The blouse piece from the BLOUSE photo lies neatly folded beside the saree, small, its fabric showing.' : '',
    '',
    'THE SAREE MUST BE EXACTLY THE SAME SAREE: the same base colour, the same motifs at the same size, shape and spacing, the same border with the same width, colours and pattern, the same pallu design, the same zari. The saree has three zones and each keeps its own pattern wherever it shows: the BODY (the main field), the BORDER and the PALLU - never put a generic pattern where the own pattern of this saree belongs. Do not add, remove, simplify or invent any motif, figure, stripe, check or border. Where the SAREE photo does not show a part clearly, use the FRONT VIEW photo for how it looks.',
    '',
    // 26 Nov production: a folded teal saree came out with twice as many leaf motifs as the real one.
    'MOTIF SPACING AND COUNT: look at how far apart the motifs sit in the SAREE photo and keep exactly that spacing - the same number of motifs per area, never more crowded and never sparser. Large motifs stay large and few; small buttis stay small. A motif is never cut in half to fill a gap, never repeated where the SAREE photo has plain cloth, and the plain cloth between motifs stays plain.',
    '',
    'QUALITY: a real, high-end product photograph - crisp fabric texture, real folds and soft natural shadows, true colours, sharp focus on the saree. No text, logo, label, watermark, price tag or frame anywhere. Exactly one photograph.'
  ].filter((line) => line !== null).join('\n');
}

function shotParts(shot, place, refs) {
  const extras = refs.extras || [];
  const parts = [{ text: shotPrompt(shot, place, { hasBlouse: !!refs.blouse, extras: extras.length }) }];
  parts.push({ text: 'SAREE - the real saree (the truth for its design, colours and border):' }, inline(refs.saree));
  extras.forEach((x, i) => parts.push({ text: `SAREE DETAIL ${i + 1} - another photo of the SAME saree (pallu, border or close-up):` }, inline(x)));
  if (refs.blouse && !shot.lightOnly) parts.push({ text: 'BLOUSE - the blouse piece sold with it:' }, inline(refs.blouse));
  if (refs.front) parts.push({ text: 'FRONT VIEW - the same saree worn by a model (only to see its border and pallu; draw no person):' }, inline(refs.front));
  return parts;
}

const CHECKS = [
  ['same_design', 'The saree in the PRODUCT PHOTO has the same motifs as the SAREE photo - the same shapes at the same size and spacing.'],
  ['same_colours', 'The same base colour and the same colours of motifs, border and zari as the SAREE photo.'],
  ['same_border', 'The same border: the same width, pattern and colours.'],
  ['nothing_added', 'No motif, figure, stripe or border appears on the saree that the SAREE photo does not show.'],
  ['same_spacing', 'The motifs sit as far apart as in the SAREE photo - not more crowded, not sparser; plain cloth between motifs stays plain.'],
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
      ...(refs.extras || []).flatMap((x, i) => [{ text: `SAREE ${i + 2} - another real photo of the SAME saree (pallu, border or close-up); what it shows counts as part of the saree:` }, toPart(x)]),
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

// Production, 26 Nov: the same photo of a pink saree's border was accepted, then 30 s later refused as
// "a different saree" - a false refusal stops the whole job, which is worse than using a doubtful photo
// (every shot is still checked against all the photos). So a photo is refused only when the checker
// names the base colour of each, says it is CERTAIN, and a second, separate look agrees.
// The firmest sign is the BODY cloth: a pallu may be a contrast colour, the body never changes. So the
// checker first says which parts EXTRA shows, then compares the body colour only when the body shows.
const SAME_SCHEMA = {
  type: 'OBJECT',
  properties: {
    main_body_colour: { type: 'STRING' },
    extra_shows: { type: 'ARRAY', items: { type: 'STRING', enum: ['body', 'pallu', 'border', 'blouse', 'not a saree'] } },
    extra_body_colour: { type: 'STRING' },
    same_body_colour: { type: 'BOOLEAN' },
    same_saree: { type: 'BOOLEAN' },
    certain: { type: 'BOOLEAN' },
    evidence: { type: 'STRING' }
  },
  required: ['main_body_colour', 'extra_shows', 'extra_body_colour', 'same_body_colour', 'same_saree', 'certain', 'evidence'],
  propertyOrdering: ['main_body_colour', 'extra_shows', 'extra_body_colour', 'same_body_colour', 'same_saree', 'certain', 'evidence']
};

const SAME_QUESTION = [
  'main_body_colour: the colour of the BODY cloth of the saree in MAIN (its main field, not the border or pallu), in two or three words.',
  'extra_shows: which parts of a saree EXTRA shows - the body (the main field), the pallu (the decorated end), the border, a blouse - or "not a saree".',
  'extra_body_colour: the colour of the body cloth in EXTRA, or "not shown" when EXTRA shows no body cloth.',
  'same_body_colour: false when EXTRA shows body cloth of a clearly different colour family than MAIN (for example teal against pink, green against red); true when it is the same colour family in other light, or when EXTRA shows no body cloth.',
  'same_saree: false when EXTRA is a different saree: body cloth of a clearly different colour, or a border of a clearly different kind (other width, colours or pattern). A close-up, a folded part, other light or another angle of the same saree is the same saree; its pallu may carry bigger or different motifs and even a contrast colour.',
  'certain: true when the difference or the match is plain to see.',
  'evidence: one short sentence.'
].join('\n');

/**
 * Each extra photo must show the SAME saree as the main photo (its pallu, border or a close-up).
 * Returns the extras that clearly do not: [{ index (1-based), evidence }]. Refused only on a certain
 * "different" that a second look confirms; a check that cannot run counts as a match.
 */
async function verifyExtras(saree, extras, signal) {
  const toPart = (img) => { const { mimeType, data } = splitDataUri(img); return { inlineData: { mimeType, data } }; };
  const ask = async (extra) => {
    try {
      const { parsed } = await studio().askInspector([
        { text: 'MAIN - a photo of a saree:' }, toPart(saree),
        { text: 'EXTRA - meant to be another photo of the SAME saree: its pallu, its border, a close-up of its fabric, or the saree folded:' }, toPart(extra),
        { text: SAME_QUESTION }
      ], SAME_SCHEMA, signal);
      if (!parsed) return null;
      // A body of another colour is decisive on its own; otherwise the checker's own verdict.
      const bodyDiffers = parsed.same_body_colour === false && Array.isArray(parsed.extra_shows) && parsed.extra_shows.includes('body');
      if (!bodyDiffers && parsed.same_saree !== false) return null;
      return { certain: bodyDiffers || parsed.certain === true, evidence: String(parsed.evidence || '').slice(0, 200) };
    } catch (err) {
      if (signal && signal.aborted) throw err;
      return null;
    }
  };
  // Any "different" gets a second look; refused only when both looks say different and at least one
  // is certain (measured 26 Nov: own photo refused 0 of 6, but an unsure first look let 1 of 3 teal through).
  const results = await Promise.all((extras || []).map(async (extra, i) => {
    const first = await ask(extra);
    if (!first) return null;
    const second = await ask(extra);
    if (!second || !(first.certain || second.certain)) {
      stepLog('Catalog', { endpoint: 'women', item: `extra photo ${i + 1}`, result: 'advised', why: second ? 'two looks said a different saree, neither was sure - the photo is used' : 'one look said a different saree, the second did not - the photo is used' });
      return null;
    }
    return { index: i + 1, evidence: (first.certain ? first : second).evidence };
  }));
  return results.filter(Boolean);
}

const isCancel = (err, signal) => (signal && signal.aborted) || /AbortError/.test(String((err && err.message) || err));

// Owner, 26 Nov: "everything should be perfect". One redo left the folded shot wrong on 2 of 4 sarees,
// so a shot that still differs is made a second time. Set PRODUCT_SHOT_MAX_REDOS to change it.
const MAX_REDOS = Math.max(0, Number(process.env.PRODUCT_SHOT_MAX_REDOS ?? 2));
// Lower is better: a passed check 0, each difference 1; an unchecked picture is kept only over a failed one.
const score = (v) => (v.checked ? v.failures.length : 0.5);

/**
 * One shot: made, checked, and made again (up to MAX_REDOS times) while the check finds a difference;
 * every redo is told every difference found so far. The best picture is kept. Throws only on cancel;
 * any other failure comes back as { error }.
 */
async function makeShot(shot, refs, { generate, signal, random } = {}) {
  const place = pickPlace(shot, random);
  const started = Date.now();
  const parts = shotParts(shot, place, refs);
  try {
    let image = await generate(parts, signal);
    let verdict = studio().config.pair.enabled ? await checkShot(refs, image, signal) : { checked: false, failures: [] };
    let regenerated = false;
    let redos = 0;
    const wrong = [];
    let last = verdict;
    while (last.failures.length && redos < MAX_REDOS) {
      wrong.push(last.failures[0].evidence || last.failures.map((f) => f.check).join(', '));
      try {
        const again = await generate([...parts, { text: `THE EARLIER ATTEMPTS WERE WRONG: ${wrong.map((w, i) => `(${i + 1}) ${w}`).join(' ')}. Make it again with the saree exactly as in the SAREE photo - its motifs, their spacing, its border and its colours.` }], signal);
        redos += 1;
        regenerated = true;
        last = await checkShot(refs, again, signal);
        if (score(last) < score(verdict)) { image = again; verdict = last; }
        if (!last.checked) break;
      } catch (err) {
        if (isCancel(err, signal)) throw err;
        break;
      }
    }
    const checkPassed = verdict.checked ? verdict.failures.length === 0 : null;
    stepLog('Catalog', { endpoint: 'women', item: `shot ${shot.id}`, result: 'made', seconds: secondsSince(started), redos, check: checkPassed === null ? 'not checked' : checkPassed ? 'passed' : `still differs: ${verdict.failures.map((f) => f.check).join(', ')}`, setting: place.slice(0, 60) });
    return { shot: shot.id, name: shot.name, setting: place, image, checkPassed, regenerated, redos, ...(checkPassed === false ? { differences: verdict.failures.map((f) => f.check) } : {}) };
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

module.exports = { SHOT_COUNT: SHOTS.length, verifyExtras, makeProductShots, makeShot, shotPrompt, shotParts, checkShot, CHECKS };
