// =============================================================================
// sareeReader - one quick look at all the photos of a saree before anything is drawn.
// =============================================================================
//
// Production, 27 Nov 2026 (Swathy Reddy, a maroon saree with thin vertical gold stripes): the views
// came out with no stripes in the pleats, a striped blouse and a gold chain on the plain red border.
// What the shop's app had sent: as the MAIN photo a crumpled close-up (stripes bent in every
// direction), as the BLOUSE a photo of the folded saree, and the good photos only as extras. The
// prompt said "copy the weave pattern" but never named the stripes, which an image model likes to
// simplify away. So, before the views:
//   1. pick the photo that shows the saree's layout best as the main one (any order a shop sends),
//   2. notice a "blouse" photo that is really the saree (it becomes an extra saree photo),
//   3. write the fabric facts down in words - body, stripes, motifs, border, pallu - and give them to
//      every view and product shot as things the picture must keep.
// One call to the text model (gemini-2.5-flash, ~2-4 s). It never stops a job: when it cannot run,
// the photos are used as sent and no facts are added.

const { stepLog, secondsSince } = require('../../lib/stepLog');

// Loaded on use: the Design Studio settings are read from the environment on first load.
const studio = () => require('../designstudio/qualityCheck');

const splitDataUri = (img) => {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(img || ''));
  return m ? { mimeType: m[1], data: m[2] } : { mimeType: 'image/jpeg', data: String(img || '') };
};
const toPart = (img) => { const { mimeType, data } = splitDataUri(img); return { inlineData: { mimeType, data } }; };

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    best_layout_photo: { type: 'INTEGER' },
    main_shows_layout: { type: 'BOOLEAN' },
    blouse_photo_shows: { type: 'STRING', enum: ['a blouse', 'this saree', 'something else', 'no blouse photo'] },
    body_colour: { type: 'STRING' },
    body_stripes: { type: 'STRING' },
    body_motifs: { type: 'STRING' },
    border: { type: 'STRING' },
    pallu: { type: 'STRING' },
    must_keep: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['best_layout_photo', 'main_shows_layout', 'blouse_photo_shows', 'body_colour', 'body_stripes', 'body_motifs', 'border', 'pallu', 'must_keep'],
  propertyOrdering: ['best_layout_photo', 'main_shows_layout', 'blouse_photo_shows', 'body_colour', 'body_stripes', 'body_motifs', 'border', 'pallu', 'must_keep']
};

const QUESTION = [
  'You are a saree expert writing exact notes for a photographer who must reproduce this saree. Answer from what the photos show, never from what sarees usually look like.',
  'best_layout_photo: the number of the SAREE photo that best shows the whole layout - the body, the border and how the pattern runs (a draped, hung, folded or flat saree). A crumpled or swirled close-up shows the layout badly.',
  'main_shows_layout: true when SAREE PHOTO 1 shows the layout clearly; false when it is a crumpled or swirled close-up or shows only a small part.',
  'blouse_photo_shows: what the BLOUSE photo shows - "a blouse" (a blouse or blouse piece), "this saree" (the saree itself, folded or draped, not a blouse), "something else", or "no blouse photo".',
  'body_colour: the colour of the BODY cloth (the main field), in two or three words.',
  'body_stripes: the stripes or lines that run through the BODY - direction (vertical along the length / horizontal / checks), colour, width, how they are grouped and spaced, and their pattern (plain, herringbone, floral chain ...). "none" if the body has no stripes.',
  'body_motifs: the motifs (buttas) on the BODY - shape, colour, size and how they are spaced (between the stripes, in rows ...). "none" if there are none.',
  'border: the border along the long edge - its colour, width and pattern, and whether it has zari or is plain. Be exact: a plain border must be called plain.',
  'pallu: the pallu (the decorated end), or "not shown".',
  'must_keep: up to 6 short rules a photo of this saree must keep, the easiest ones to lose first (thin stripes, a plain border, motif spacing ...). Example: "thin vertical gold stripes run down the whole body, including the pleats".'
].join('\n');

/**
 * @param {{ saree: string, extras?: string[], blouse?: string|null }} photos  data URIs
 * @returns {Promise<{ read: boolean, bestIndex: number, mainShowsLayout: boolean, blouseShows: string, facts: string|null }>}
 *   bestIndex 0 = the main photo, 1..n = extras[0..n-1]
 */
async function readSaree({ saree, extras = [], blouse = null, colour = null }, signal) {
  const started = Date.now();
  const none = { read: false, bestIndex: 0, mainShowsLayout: true, blouseShows: blouse ? 'a blouse' : 'no blouse photo', facts: null };
  const photos = [saree, ...extras];
  const parts = [];
  photos.forEach((p, i) => parts.push({ text: `SAREE PHOTO ${i + 1}${i === 0 ? ' (sent as the main photo)' : ''}:` }, toPart(p)));
  if (blouse) parts.push({ text: 'BLOUSE photo (sent as the blouse):' }, toPart(blouse));
  parts.push({ text: QUESTION });
  // 27 Nov: one read in a run came back unusable while the same read alone worked 6 of 6 times - an
  // unusable answer is asked once more while there is time (the route gives the read 15 s in all).
  let parsed = null;
  for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
    if (attempt === 2 && Date.now() - started > 8000) break;
    try {
      ({ parsed } = await studio().askInspector(parts, SCHEMA, signal));
    } catch (err) {
      if (signal && signal.aborted) throw err;
    }
  }
  if (!parsed) {
    stepLog('Catalog', { endpoint: 'women', item: 'read saree', result: 'skipped', seconds: secondsSince(started), why: 'the photos are used as sent' });
    return none;
  }
  const best = Number.isInteger(parsed.best_layout_photo) && parsed.best_layout_photo >= 1 && parsed.best_layout_photo <= photos.length
    ? parsed.best_layout_photo - 1 : 0;
  const out = {
    read: true,
    bestIndex: best,
    mainShowsLayout: parsed.main_shows_layout !== false,
    blouseShows: blouse ? (parsed.blouse_photo_shows || 'a blouse') : 'no blouse photo',
    facts: factsText(parsed, { colour })
  };
  stepLog('Catalog', { endpoint: 'women', item: 'read saree', result: 'made', seconds: secondsSince(started), main: out.mainShowsLayout ? 'shows the layout' : `close-up, photo ${best + 1} is better`, blouse: blouse ? out.blouseShows : null, stripes: String(parsed.body_stripes || '').slice(0, 60) });
  return out;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300);
const shown = (s) => clean(s) && !/^(none|not shown|n\/a)\.?$/i.test(clean(s));

/** The facts as the text the image model is given. */
function factsText(p, { colour = null } = {}) {
  const lines = [];
  // A colour variant changes the body colour: the facts then give the design only.
  if (colour) lines.push(`- Colours: the base fabric becomes ${clean(colour.name || 'the requested colour')} as asked above; the facts below are about the DESIGN only, not its colours.`);
  else if (shown(p.body_colour)) lines.push(`- Body colour: ${clean(p.body_colour)}.`);
  lines.push(shown(p.body_stripes) ? `- Body stripes: ${clean(p.body_stripes)}. They run through the WHOLE body, including every pleat and the part over the shoulder.` : '- Body stripes: none - do not add any.');
  lines.push(shown(p.body_motifs) ? `- Body motifs: ${clean(p.body_motifs)}.` : '- Body motifs: none - do not add any.');
  if (shown(p.border)) lines.push(`- Border: ${clean(p.border)}. Nothing else is added to it.`);
  if (shown(p.pallu)) lines.push(`- Pallu: ${clean(p.pallu)}.`);
  const keep = Array.isArray(p.must_keep) ? p.must_keep.map(clean).filter(Boolean).slice(0, 6) : [];
  if (keep.length) lines.push(...keep.map((k) => `- MUST KEEP: ${k}`));
  return lines.length ? `SAREE FACTS (read from the photos; every one of them must be true in your picture):\n${lines.join('\n')}` : null;
}

module.exports = { readSaree, factsText, SCHEMA };
