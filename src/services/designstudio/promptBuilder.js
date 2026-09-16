// =============================================================================
// promptBuilder.js — the single request that becomes the photograph.
// =============================================================================
//
// Structure (text and images interleaved, in this order):
//
//   1. TASK             one paragraph: what to make and that references are a spec
//   2. REFERENCES       "[Image N] DESIGN - PALLU. Goes on: ..." followed by that
//                       image; the same for each fabric and the model. Labelling
//                       each image right next to it is what stops the model
//                       blending a border into a pallu.
//   3. THE GARMENT      how this garment is constructed and styled
//   3b. WORN WITH IT    the supporting pieces a real photo needs (a saree's
//                       blouse, a blouse's saree): plain, never the product
//   4. DESIGN RULES     copy exactly, take only the design, place it only in its area
//   5. FABRIC RULES     exact colour, weave, sheen, drape
//   6. THE MODEL        generated or the reference person, and a pose that shows
//                       every referenced area (the back if a BACK design exists)
//   7. THE PHOTOGRAPH   framing, backdrop, light, lens, focus
//   8. QUALITY BAR      what must never appear
//   9. CUSTOMER NOTES   last, and explicitly below the references in priority
//
// No I/O. The same job always produces the same text. It records on the job
// which image number each reference got, so later messages can refer to it.
//
const { garmentGuide, describeArea, GLOBAL_AREAS, BACK_AREAS, taxonomy } = require('./garmentGuide');
const { config } = require('./config');
const { sameColourFamily } = require('./colours');

const clean = (s) => String(s).replace(/\s+/g, ' ').replace(/"/g, '\'').trim();
const bullets = (lines) => lines.map((l) => `- ${l}`).join('\n');

function areaName(garmentId, areaId) {
  const area = taxonomy.getDesignTypes(garmentId).find((a) => a.id === areaId);
  return area ? area.name : areaId;
}

/** "SLEEVE" on a blouse -> "sleeve of the blouse"; OVERALL -> "whole saree". */
function partWords(areaId, product) {
  if (areaId === 'OVERALL') return `whole ${product}`;
  return `${areaId.toLowerCase().replace(/_/g, ' ')} of the ${product}`;
}

/** The parts of a photographed garment that are NOT this area, in plain words. */
// A BACK design owns the back neckline ("back neck shape"), and a FRONT design
// runs "from the neckline down to the hem", so neither is told to ignore those.
const PART_WORDS = [
  ['neckline', /NECK|COLLAR|FRONT|BACK/],
  ['sleeves', /SLEEVE|HAND/],
  ['body', /^BODY$|FRONT|BACK|SKIRT|FLARE|PLEAT/],
  ['all-over print', /PRINT/],
  ['borders', /BORDER|PALLU|WAIST/],
  ['hem', /HEM|FRONT/]
];
/**
 * Areas that are a band along an edge. Not NECK or COLLAR_NECK: a yoke is a panel,
 * and squeezing it into a band would lose it.
 */
const EDGE_AREAS = new Set(['BORDER', 'BORDER_HEM', 'HEMLINE', 'HEM_BOTTOM', 'BOTTOM_BORDER', 'BOTTOM_ANKLE', 'WAISTBAND', 'WAIST_BELT', 'HAND']);

/** Areas that ARE the garment's main cloth, so they always take the fabric colour. */
const MAIN_PANEL_AREAS = new Set(['FRONT', 'BACK', 'BODY', 'SKIRT', 'FLARE', 'SKIRT_FLARE', 'FLARE_PANTS', 'LEG', 'BOTTOM_SALWAR', 'PLEAT', 'PALLU', 'OVERALL', 'PRINT', 'PRINT_PATTERN']);

/** "Motifs in gold. Background is deep maroon red." -> "deep maroon red". */
function backgroundColourOf(colours) {
  if (!colours) return null;
  const m = String(colours).match(/background(?:\s+stripes?)?(?:\s+colou?r)?\s*(?:is|are|:)?\s*([a-z][a-z ,/-]{2,40}?)(?:[.;]|$)/i);
  return m ? m[1].trim() : null;
}

/**
 * The ground colour of the named part in its reference photograph. The describe
 * step's own groundColour first; the "background: ..." phrase of its colours as a
 * fallback. Measured: the phrase alone missed "Solid black." and "Navy blue and
 * white tiers.", so a black waist belt and navy-and-white skirt tiers were copied
 * onto a lilac gown with nothing telling the model they were the reference's cloth.
 */
function referenceGroundOf(info) {
  if (!info) return null;
  const said = clean(info.groundColour || '');
  if (said) return said;
  return backgroundColourOf(info.colours) || solidColourOf(info.colours);
}

/** "Solid bright red." -> "bright red". */
function solidColourOf(colours) {
  const m = String(colours || '').trim().match(/^(?:solid|plain)\s+([a-z][a-z /-]{2,30}?)\.?$/i);
  return m ? m[1].trim() : null;
}

/**
 * A printed design, and whether it also carries raised work on top.
 * Measured: "Block print with mirror work" got the print lock, which forbids
 * embroidery, and the inspector then failed the mirror work as "not printed".
 */
function printKind(technique) {
  const t = String(technique || '');
  if (!/print|ajrakh|kalamkari|bagru|dabu/i.test(t) || /woven|brocade|jacquard|zari/i.test(t)) return null;
  if (/mirror|sequin|bead|pearl|embroider|stitch|thread|zardosi|aari|gota|appliqu|embellish|stone/i.test(t)) return 'embellished';
  if (/foil|metallic|gold|silver|sheen|shimmer|glitter/i.test(t)) return 'foil';
  return 'flat';
}

/** Where a supporting piece most often picks up a stray band. */
function edgesOf(pieces, garmentId) {
  if (garmentId === 'SAREE') return 'armholes and neckline';
  if (/blouse|choli/.test(pieces)) return 'sleeve ends, cuffs and neckline';
  return 'edges and hems';
}

/** Attached trims, not cut from the garment's fabric. */
const TRIM_AREAS = new Set(['TASSEL', 'BUTTON']);

/** "SLEEVE" -> "sleeve"; for a photo of a whole garment: "take ONLY its sleeve". */
function areaWords(areaId) {
  return areaId.toLowerCase().replace(/_/g, ' ');
}
function otherParts(areaId) {
  return `its ${PART_WORDS.filter(([, owns]) => !owns.test(areaId)).map(([word]) => word).join(', ')}`;
}

/**
 * The references in the order the image model sees them. Used both for numbering
 * the labels and for the describe step, so [Image 3] means the same thing to both.
 * @returns {{ ref: number, kind: string, label: string, image: Object }[]}
 */
function referenceList(job) {
  const items = [];
  let ref = 0;
  const product = garmentGuide(job.garmentId).product;
  for (const d of job.designs) {
    items.push({ ref: ++ref, kind: 'design', label: `${d.areaId} (${d.areaName})`, part: partWords(d.areaId, product), image: d.image });
  }
  for (const f of job.fabrics) items.push({ ref: ++ref, kind: 'fabric', label: f.name || `fabric ${f.index + 1}`, image: f.image });
  if (job.model.kind === 'reference') items.push({ ref: ++ref, kind: 'model', label: 'the model to dress', image: job.model.image });
  return items;
}

/**
 * Drapes and trims that exist only if a design reference asks for them. Decided
 * from the designs actually sent, never left to "only if" wording.
 * Measured: "Add a dupatta only if a design reference asks for one" still put a
 * dupatta on a suit (a suit cannot even have a DUPATTA design), and a dupatta with
 * no TASSEL design came out with tassels on both ends.
 */
function extrasLines(job, g) {
  const areas = new Set(job.designs.map((d) => d.areaId));
  const lines = [];
  if (areas.has('DUPATTA')) {
    lines.push('Add one dupatta, carrying the DUPATTA design reference.');
  } else if (job.garmentId !== 'DUPATTA' && job.garmentId !== 'LEHANGA') {
    lines.push('No dupatta, stole, shawl or scarf of any kind.');
  }
  if (job.garmentId === 'DUPATTA' && !areas.has('TASSEL')) {
    // Measured: a PALLU_END photo of a whole dupatta with tassels still produced tassels.
    lines.push('No tassels, latkans or pom-poms on the dupatta ends - even if a reference photograph of a whole dupatta shows them - and no fringe unless a design reference shows one.');
  }
  if (job.garmentId === 'SAREE') {
    // Measured: multi-coloured tassels appeared on a pallu no reference showed with any.
    lines.push('No tassels, latkans, pom-poms or fringe on the pallu end or anywhere on the saree: the pallu ends in a neat woven or hemmed edge.');
  }
  if (job.garmentId === 'DUPATTA' && !areas.has('BODY') && !areas.has('OVERALL') && !areas.has('PRINT')) {
    // Measured: the same photo's body buttis appeared on a dupatta with no BODY design.
    lines.push('The body of the dupatta between its borders and ends is plain fabric: no buttis, motifs or print from any reference photograph (the fabric\'s own weave may show).');
  }
  return lines;
}

/**
 * How much of the model the photograph shows. The product must fill the frame
 * and never be cropped; the supporting pieces fall out of frame instead.
 */
function framingLine(g) {
  const ratio = config.gemini.aspectRatio;
  if (g.framing === 'waist-up') {
    return `A waist-up portrait catalogue photograph in ${ratio}: the frame runs from a little above the head down to the upper thighs, so the ${g.product} fills most of the photograph and every detail of it is large and sharp. The ${g.product} itself is never cropped - all of it, including both sleeves and its full hem, is inside the frame. This is deliberately not a full-length photograph: the knees, legs and feet are NOT in it.`;
  }
  if (g.framing === 'three-quarter') {
    return `A three-quarter-length portrait catalogue photograph in ${ratio}: the frame runs from a little above the head down to mid-calf, so the ${g.product} fills most of the photograph. The ${g.product} itself is never cropped - both of its hanging ends and any tassels are fully inside the frame. This is deliberately not a full-length photograph: the bottom edge of the frame cuts across the lower legs at mid-calf, and the ankles and feet are NOT in it.`;
  }
  // Measured: bottom wear came out cropped at the chest, with no head or face; and a
  // saree hem and feet touched the bottom edge in both of one request's attempts.
  return `A full-length portrait catalogue photograph in ${ratio}, showing the model from head to toe with a little space above the head and below the feet. Nothing is cropped: the model's whole head and face are inside the frame, and both feet stand on visible floor with a clear strip of floor below them - the hem of the ${g.product} and the feet never touch the bottom edge of the photograph.`;
}

/** How /options describes each garment's default colour for its supporting pieces. */
const DEFAULT_PAIRING_COLOUR = {
  match: 'matches the main fabric',
  coordinate: 'coordinates with the product',
  contrast: 'a quiet neutral that sets the product off'
};

/**
 * What the model wears WITH the product, and in what colour.
 *
 * A real photograph of a saree needs a blouse, and a photograph of a blouse
 * needs a saree - but only one of them is the product. Measured: while the
 * prompt said the blouse was "plain unless a design reference describes it", a
 * pallu design moved onto the blouse. So the supporting pieces are named, kept
 * plain, and their colour is decided here: the caller's pairWith colour, else the
 * garment's default (the main fabric's colour for a saree's blouse, a quiet
 * neutral for a blouse's saree).
 *
 * @returns {null | { pieces: string, plural: boolean, looks: string, colour: string, exact: boolean, from: string, note: string|null }}
 */
function pairing(job) {
  const g = garmentGuide(job.garmentId);
  if (!g.pairedWith) return null;
  const stated = (words, hex) => [words ? clean(words) : null, hex ? `hex ${hex}` : null].filter(Boolean).join(', ');
  const base = {
    pieces: g.pairedWith.pieces,
    plural: g.pairedWith.plural,
    looks: g.pairedWith.looks,
    note: job.pairWith && job.pairWith.note ? clean(job.pairWith.note) : null
  };

  if (job.pairWith && (job.pairWith.color || job.pairWith.colorHex)) {
    return { ...base, colour: stated(job.pairWith.color, job.pairWith.colorHex), exact: true, from: 'the caller' };
  }
  const main = job.fabrics.find((f) => !f.appliesTo && (f.color || f.colorHex));
  if (g.pairedWith.colour === 'match') {
    return main
      ? { ...base, colour: stated(main.color, main.colorHex), exact: true, from: `the ${g.product}'s main fabric` }
      : { ...base, colour: `the same colour as the ${g.product}'s main fabric`, exact: false, from: 'the default' };
  }
  // Measured: "coordinates with the palette" gave a rust kurti a green churidar
  // (the green kurti its neck design was photographed on) and an emerald
  // sherwani a black one (the black sherwani its cuffs came from). A default
  // colour is chosen from the product itself, never from a reference photo.
  const notFromPhotos = ' - never a colour that appears only in a reference photograph, such as the colour of a garment a design was photographed on';
  if (g.pairedWith.colour === 'coordinate') {
    const tone = main
      ? `a deeper or lighter tone of ${stated(main.color, main.colorHex)} (the ${g.product}'s own fabric colour), or a quiet neutral`
      : `a colour taken from the ${g.product}'s own fabric, or a quiet neutral`;
    return { ...base, colour: `${tone}${notFromPhotos}`, exact: false, from: 'the default' };
  }
  return {
    ...base,
    colour: `a quiet, solid neutral (ivory, beige, soft grey or black) that is clearly different from the ${g.product}'s own colour, so the ${g.product} stands out${notFromPhotos}`,
    exact: false,
    from: 'the default'
  };
}

/**
 * @param {Object} job  A resolved job whose images have been prepared.
 * @param {Object} [options]
 * @param {Map<number, Object>} [options.descriptions]  From describeReferences.
 * @returns {{ parts: Object[], text: string, warnings: string[], pose: 'front'|'back' }}
 */
function buildPrompt(job, { descriptions = new Map() } = {}) {
  const g = garmentGuide(job.garmentId);
  const warnings = [];
  const parts = [];
  const textLog = [];
  const addText = (t) => { parts.push({ text: t }); textLog.push(t); };
  const addImage = (image, label) => {
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } });
    textLog.push(`<${label}>`);
  };

  // A reference model with no stated gender is just "the model": the photo decides.
  const wearerWord = job.model.gender === 'male' ? 'man' : job.model.gender === 'female' ? 'woman' : 'model';
  const possessive = job.model.gender === 'male' ? 'his' : 'her';
  const designAreas = job.designs.map((d) => d.areaId);
  const hasGlobal = designAreas.some((a) => GLOBAL_AREAS.has(a));
  const hasZone = designAreas.some((a) => !GLOBAL_AREAS.has(a));
  const needsBack = designAreas.some((a) => BACK_AREAS.has(a));
  const pose = needsBack ? 'back' : 'front';
  if (needsBack) {
    // Measured on a real kurti (BACK + NECK): the back yoke came out perfectly and
    // the neckline could not be seen at all. Say so rather than let a caller wonder.
    const hiddenByBackPose = job.designs
      .filter((d) => !BACK_AREAS.has(d.areaId) && !GLOBAL_AREAS.has(d.areaId))
      .map((d) => d.areaId);
    if (hiddenByBackPose.length) {
      warnings.push(`One photograph cannot show the back and the front at once. The model is posed turning away so the BACK design is clear, which leaves ${hiddenByBackPose.join(', ')} partly or fully hidden. Send a second request without the BACK design for a front view of those.`);
    }
  }

  const pair = pairing(job);
  if (job.pairWith && !pair) {
    warnings.push(`pairWith was not used: a ${g.product} is the whole outfit, so nothing else is worn with it.`);
  }

  // ── 1. TASK ────────────────────────────────────────────────────────────────
  const productLine = job.productName
    ? `The finished product is sold as "${clean(job.productName)}" - treat that name as a hint to the style and occasion only, and never draw any text into the image.`
    : null;
  addText([
    'TASK',
    `Create one photorealistic e-commerce catalogue photograph of a ${wearerWord} wearing a brand-new ${g.product}, ` +
    'tailored from the exact fabrics and decorated with the exact designs shown in the reference images below. ' +
    'The references are a strict specification from the customer, not loose inspiration: the finished garment must look as if it was made from these very designs and fabrics.',
    ...(pair ? [`The ${g.product} is the only product in this photograph. Every design reference below belongs to the ${g.product} and to nothing else the model wears.`] : []),
    ...(productLine ? [productLine] : []),
    '',
    'REFERENCE IMAGES'
  ].join('\n'));

  // ── 2. REFERENCES ──────────────────────────────────────────────────────────
  // What the describe step saw in a reference, as lines under its label.
  const described = (ref) => {
    const info = descriptions.get(ref);
    if (!info) return [];
    const lines = [];
    if (info.motifs) lines.push(`Motifs in this reference: ${info.motifs}`);
    if (info.layout) lines.push(`Layout and repeat: ${info.layout}`);
    if (info.colours) lines.push(`Colours in this reference: ${info.colours}`);
    if (info.technique) lines.push(`Technique: ${info.technique}`);
    // Measured: an ajrakh block print came out as gold woven zari.
    const kind = printKind(info.technique);
    if (kind === 'flat') {
      lines.push('TECHNIQUE LOCK: this design is PRINTED - flat, matte colour printed into the cloth. Reproduce it as a print: no woven zari, no brocade, no metallic thread, no embroidery, no raised texture, no metallic sheen on the motifs.');
    } else if (kind === 'foil') {
      lines.push('TECHNIQUE LOCK: this design is a FOIL or metallic PRINT - the motifs may shine, but they lie completely flat on the cloth. Reproduce it as a print: no woven zari, no brocade, no metallic thread, no embroidery, no raised texture.');
    } else if (kind === 'embellished') {
      lines.push('TECHNIQUE LOCK: the motifs of this design are PRINTED flat on the cloth, with the raised work named above (for example mirrors, sequins or embroidery) added on top of the print. Keep the printed motifs flat - never turn them into woven zari or brocade - and keep that raised work exactly where the reference shows it.');
    }
    if (info.notes) lines.push(`Must not be missed: ${info.notes}`);
    if (lines.length) lines.unshift('This is what the reference actually shows - reproduce all of it:');
    return lines;
  };

  // Which fabric covers a part: its own, or the main fabric.
  const fabricRefNumber = (fabric) => job.designs.length + fabric.index + 1;
  const fabricFor = (areaId) => job.fabrics.find((f) => f.appliesTo && f.appliesTo.includes(areaId))
    || job.fabrics.find((f) => !f.appliesTo)
    || null;
  // Measured: a brocade jaal fabric replaced the multi-coloured butis a BODY
  // design asked for. The describe step's own words are the reliable signal -
  // a pixel measure cannot tell an all-over pattern from a sparkly velvet.
  const PATTERNED = /jaal|jacquard|brocade|all-?over (?:pattern|design)|self[- ]design|woven pattern|damask|trellis/i;
  const patternedFabricFor = (areaId) => {
    const fabric = fabricFor(areaId);
    if (!fabric) return null;
    const info = descriptions.get(fabricRefNumber(fabric));
    if (!info) return null;
    const words = `${info.motifs} ${info.technique} ${info.layout}`;
    // Measured: an olive banarasi with small woven "diamond-shaped florets" took
    // over a third of a dupatta body that had a leheriya design - no keyword above
    // matched. Any fabric the describe step says has motifs counts.
    const hasMotifs = info.motifs && !/^\s*(?:-|none|no\b|plain|n\/?a|solid)/i.test(info.motifs);
    return PATTERNED.test(words) || hasMotifs ? fabric : null;
  };

  // What the quality gate checks the finished photograph against (qualityCheck.js).
  const review = { parts: [] };

  let n = 0;
  for (const d of job.designs) {
    n += 1;
    // Trims are not cut from the fabric, so a patterned fabric cannot fight them.
    const clash = TRIM_AREAS.has(d.areaId) ? null : patternedFabricFor(d.areaId);
    const lines = [
      `[Image ${n}] DESIGN for ${d.areaId} (${d.areaName})`,
      `Goes on: ${describeArea(job.garmentId, d.areaId)}.`,
      ...described(n)
    ];
    // Measured: a SLEEVE reference that was a photo of a whole printed kurti gave
    // the new blouse that kurti's neckline embroidery and all-over rose print too.
    // Measured the other way: flat artwork (a dot pattern, a photo of flowers) was
    // then read as "does not show a border" and the notes replaced the pictures.
    if (!GLOBAL_AREAS.has(d.areaId)) {
      lines.push(`If this photograph is a close-up, a flat swatch, trim or artwork rather than a whole garment, the whole picture is the design for the ${partWords(d.areaId, g.product)}. If it shows a whole garment or outfit, take ONLY its ${areaWords(d.areaId)}: every other part of it - ${otherParts(d.areaId)}, and any other garment worn with it - is NOT part of this reference and must not appear anywhere on the new ${g.product} - not on its sleeves, cuffs, neckline, hem or any other part without a design of its own - and no embellishment from those other parts is moved onto this part.`);
    }
    if (d.image && d.image.cropped) {
      lines.push(`This picture has been cropped from a larger photograph to show the ${partWords(d.areaId, g.product)}. Anything cut off at its edges - the rest of that garment, its colour, its other decoration - is not part of this design.`);
    }
    lines.push('This picture decides the design. Where a customer note describes something different from the picture, follow the picture.');
    // Measured twice: a PALLU_END photo of a whole dupatta with purple tassels put
    // those tassels on the new dupatta, even with a general "no tassels" rule.
    // Naming the exact picture that shows them is what the model needs.
    const seen = descriptions.get(n) || {};
    if (!designAreas.includes('TASSEL') && d.areaId !== 'TASSEL'
      && /tassel|latkan|pom-?pom|fringe/i.test(`${seen.motifs || ''} ${seen.layout || ''} ${seen.notes || ''} ${seen.technique || ''}`)) {
      lines.push(`[Image ${n}] also shows tassels, latkans, pom-poms or a fringe. They are NOT part of this design: do not put them anywhere on the ${g.product}.`);
    }
    if (clash) {
      const fabricName = clash.name ? clean(clash.name) : `fabric ${clash.index + 1}`;
      lines.push(`IMPORTANT for this part: its fabric (${fabricName}) carries its own all-over woven pattern. That pattern must stay a quiet ground here - THIS design's motifs are what must be seen on ${d.areaId}, at their own size and colours. Do not let the fabric's pattern replace them.`);
      warnings.push(`${d.areaId} has both a design and a patterned fabric (${fabricName}, described as ${clean((descriptions.get(fabricRefNumber(clash)) || {}).technique || 'patterned')}). The fabric's own pattern can compete with the design. For the sharpest result, send a plainer fabric for ${d.areaId}.`);
    }
    // The caller's own ground colour for this part wins. Otherwise take it from
    // the fabric covering the part - measured: without this line a mustard sleeve
    // reference made mint sleeves mustard, and a blue gota reference made a rust
    // lehenga's hem blue. The same wording fixed an ivory collar when set by hand.
    //
    // But a CONTRAST PANEL is different: measured, a red embroidered yoke on a blue
    // kurta came out indigo, because indigo was the fabric. There red is part of the
    // design, not the colour of the garment it was photographed on. The describe
    // step says which it is; a contrast panel keeps its own colour and says so.
    const partFabric = fabricFor(d.areaId);
    const info = descriptions.get(n) || {};
    // Measured: a real fabric photo sent without a colour gave the blouse no ground
    // colour at all, and its sleeves and yoke came out navy and peach - the colours
    // of the garments in the design references. The fabric photo's own reading
    // is the fallback for its colour.
    const fabricInfo = partFabric ? descriptions.get(fabricRefNumber(partFabric)) : null;
    const fabricRead = fabricInfo && (clean(fabricInfo.groundColour || '') || backgroundColourOf(fabricInfo.colours) || solidColourOf(fabricInfo.colours));
    // Only a small part can be a contrast panel. Measured in production: a FRONT
    // reference with a black yoke was read as a contrast panel, and the whole front
    // of a teal kurti came out red while its back stayed teal.
    // And a part whose colour matches the rest of its photographed garment is not a
    // contrast panel, whatever the describe step called it (aqua trim on turquoise).
    const sameAsGarment = info.garmentColour && info.groundColour && sameColourFamily(info.groundColour, info.garmentColour);
    const contrastColour = !MAIN_PANEL_AREAS.has(d.areaId) && /contrast/i.test(info.groundType || '') && !sameAsGarment && clean(info.groundColour || '');
    const ground = (d.groundColor || d.groundColorHex)
      ? { words: d.groundColor, hex: d.groundColorHex, from: 'the caller' }
      : contrastColour
        ? { words: contrastColour, contrast: true }
        : (partFabric && (partFabric.color || partFabric.colorHex))
          ? { words: partFabric.color, hex: partFabric.colorHex, from: `its fabric${partFabric.name ? ` (${clean(partFabric.name)})` : ''}` }
          : fabricRead
            ? { words: fabricRead, from: `its fabric photograph${partFabric.name ? ` (${clean(partFabric.name)})` : ''}` }
            : null;
    const referenceBackground = referenceGroundOf(info);
    const printed = printKind(info.technique) === 'flat' || printKind(info.technique) === 'foil';
    // Measured: gold zari borders and a Paithani pallu photographed on mustard and
    // beige were failed as "gold ground, not wine" - zari is gold, that is right.
    const zariGround = !!referenceBackground && (sameColourFamily(referenceBackground, 'gold') || sameColourFamily(referenceBackground, 'beige'))
      && /zari|metallic|brocade|tissue|paithani|banaras|kanjiv/i.test(`${info.technique || ''} ${info.motifs || ''}`);
    review.parts.push({
      zariGround,
      trim: TRIM_AREAS.has(d.areaId),
      area: d.areaId,
      part: partWords(d.areaId, g.product),
      where: describeArea(job.garmentId, d.areaId).split(/\.\s/)[0],
      ground: ground ? (ground.contrast ? ground.words : [ground.words, ground.hex].filter(Boolean).join(' ')) : null,
      contrast: !!(ground && ground.contrast),
      referenceBackground: ground && !ground.contrast ? referenceBackground : null,
      printed
    });
    if (ground && ground.contrast) {
      lines.push(`Ground colour for this part: ${ground.words}. In its reference this part is a separately coloured contrast panel, so it keeps that panel colour instead of the fabric's colour; the rest of the garment stays in its fabric colour.`);
      warnings.push(`${d.areaId} is a contrast panel in its reference, so it keeps its own colour (${ground.words}) instead of the fabric colour. To choose its colour, send designs[${d.index}].groundColorHex.`);
    } else if (ground) {
      const stated = [ground.words ? clean(ground.words) : null, ground.hex ? `hex ${ground.hex}` : null].filter(Boolean).join(', ');
      lines.push(`Ground colour for this part: ${stated} - from ${ground.from}. Reproduce the motifs on exactly this colour. The reference photo's own background colour must NOT appear on the garment.`);
      // Naming the reference's colour is what makes the model drop it: measured on a
      // lilac gown whose skirt reference was navy-and-white tiers.
      if (referenceBackground && !sameColourFamily(referenceBackground, stated)) {
        lines.push(`In [Image ${n}] this part's cloth is ${referenceBackground}. That is only the colour of the garment that was photographed: on the new ${g.product} every area of ${referenceBackground} on this part - its cloth, tiers, panels, cuffs, belts, bands, piping, blocks and stripes, and any lighter or darker shade of it - is ${stated} instead. Take the shape, construction and motifs from the reference, never its cloth colour.`);
      }
      // Measured: turquoise-and-gold stripes on an emerald saree came out as gold
      // AND blue stripes - the reference's background stripes were kept as a motif.
      // Measured again in production: a lighter tint of that blue survived as stripes.
      lines.push(`If this design is stripes, checks, bands or blocks, the stripes or blocks in the reference's background colour are ground, not motif: they become ${stated} too - and so does every lighter or darker shade or tint of that background colour (for example sky blue, light blue or teal stripes when the reference's background is blue). Only the decorative colours (for example gold zari stripes or coloured buttis) keep their own colour.`);
    }
    lines.push(d.keepMotifColors
      ? 'Keep the motif colours exactly as they are in this reference, including multi-coloured motifs - do not turn them into a single colour.'
      : 'Recolour the motifs to suit this part\'s own fabric palette rather than copying the reference\'s motif colours.');
    // Measured: a pallu ended in a large blank panel of plain fabric.
    lines.push(d.coverage === 'reference'
      ? 'Follow this reference\'s own layout exactly, including any plain areas it shows.'
      : 'A repeating pattern covers the whole of this part, edge to edge and right to its end, with no large plain panel or empty gap; only a narrow finishing edge of a few centimetres may be plain. But if this reference is ONE placed piece - a yoke, neckpiece, appliqué, patch or a single motif - make it once, at its real size and in its natural position; never stretch or repeat it to fill the part.');
    // Measured: a BORDER_HEM reference that was a dress dotted with sequins all
    // over turned the whole gown skirt into polka dots. An edge area stays a band.
    if (EDGE_AREAS.has(d.areaId)) {
      lines.push(`This is an edge area. However much of the garment its reference photograph covers, reproduce this design only as a band of realistic width along the ${areaWords(d.areaId)} - never spread it over the rest of the ${g.product}.`);
      const words = `${info.motifs || ''} ${info.layout || ''} ${info.notes || ''}`;
      if (/all[- ]?over|throughout|entire (?:garment|dress|gown|outfit|fabric|surface)|whole (?:garment|dress|gown|outfit|fabric|surface)|covers? the (?:whole|entire)/i.test(words)) {
        warnings.push(`The ${d.areaId} reference shows a pattern across the whole garment rather than a ${areaWords(d.areaId)} band, so it is used only as a band along the ${areaWords(d.areaId)}. A close-up of the band itself gives a closer match.`);
      }
    }
    // Measured: a CORNER reference that was a shop rack of a dozen dupattas; the
    // model invented a corner motif and nobody was told.
    // Measured twice: the describe step silently skipped a shop-rack photo and an
    // "Eid Mubarak" poster while describing the other references, and the model
    // invented a heavy paisley hem. A reference left out while others were read is
    // treated as unclear too.
    const skipped = !!(descriptions.declined && descriptions.declined.has(n));
    const problem = info.problem ? clean(info.problem) : skipped ? `The picture could not be read as a ${areaWords(d.areaId)} design.` : '';
    if (problem) {
      warnings.push(`designs[${d.index}] (${d.areaId}): ${problem.replace(/\.?$/, '.')} The result for ${d.areaId} is a best guess - a close-up of that part gives an accurate match.`);
      lines.push(`This reference is unclear (${problem.replace(/\.$/, '')}). Use only what can clearly be seen of a ${areaWords(d.areaId)} design; where nothing is clear, keep this part simple, in the garment's own colours, rather than inventing a busy design.`);
    }
    if (d.note) lines.push(`Customer note for this design: ${clean(d.note)}`);
    addText(lines.join('\n'));
    addImage(d.image, `design ${d.areaId}`);
    d.imageNumber = n;
    if (d.image.lowResolution) {
      warnings.push(`designs[${d.index}] (${d.areaId}) is only ${Math.max(d.image.original.width, d.image.original.height)}px; fine detail in that design may be lost.`);
    }
  }

  for (const f of job.fabrics) {
    n += 1;
    const label = f.name ? clean(f.name) : `Fabric ${f.index + 1}`;
    const usedFor = f.appliesTo
      ? `Used for: ${f.appliesTo.map((a) => `${a} (${areaName(job.garmentId, a)})`).join(', ')} only.`
      : 'Used for: the main fabric of the whole garment, meaning every part that has no fabric of its own.';
    const lines = [`[Image ${n}] FABRIC: ${label}${f.itemCode ? ` [${clean(f.itemCode)}]` : ''}`, usedFor, ...described(n)];
    if (f.material) lines.push(`Material: ${clean(f.material)}. Show this material's real weave, weight and surface finish.`);
    // The stated colour is the customer's stock record. A fabric photo can be shot
    // in warm or cool light, so the words and the hex decide the base colour.
    if (f.color || f.colorHex) {
      const stated = [f.color ? clean(f.color) : null, f.colorHex ? `hex ${f.colorHex}` : null].filter(Boolean).join(', ');
      lines.push(`Colour: ${stated}. That is this fabric's exact colour: match it precisely, and use the photograph for the weave, motifs and metallic zari rather than for the shade.`);
    }
    if (f.note) lines.push(`Customer note for this fabric: ${clean(f.note)}`);
    addText(lines.join('\n'));
    addImage(f.image, `fabric ${label}`);
    f.imageNumber = n;
    if (f.image.lowResolution) {
      warnings.push(`fabrics[${f.index}] is only ${Math.max(f.image.original.width, f.image.original.height)}px; its weave may not be reproduced precisely.`);
    }
  }

  if (job.model.kind === 'reference') {
    n += 1;
    addText(`[Image ${n}] MODEL: the person to dress in the new garment.`);
    addImage(job.model.image, 'model');
    job.model.imageNumber = n;
  }

  const allImages = [...job.designs, ...job.fabrics, job.model].map((x) => x.image).filter(Boolean);
  if (allImages.some((img) => img.shrunkToFit)) {
    warnings.push('The images were very detailed, so some were compressed further to fit the image model\'s request limit; the finest detail may be slightly softer.');
  }

  // ── 3. THE GARMENT ─────────────────────────────────────────────────────────
  addText([
    'THE GARMENT',
    g.outfit,
    bullets(g.construction),
    ...extrasLines(job, g).map((l) => `- ${l}`),
    ...(g.styling ? [g.styling] : [])
  ].join('\n'));

  // ── 3b. WHAT THE MODEL WEARS WITH IT ───────────────────────────────────────
  if (pair) {
    const is = pair.plural ? 'are' : 'is';
    const it = pair.plural ? 'them' : 'it';
    const lines = [
      `The product is the ${g.product}. The ${pair.pieces} ${is} NOT the product: ${pair.plural ? 'they only complete' : 'it only completes'} the photograph.`,
      `The ${pair.pieces}: ${pair.looks}.`,
      // Measured three times: a supporting piece copied the outfit of a person in a
      // reference photo (a black crop T-shirt twice, a green and a black churidar).
      `The ${pair.pieces} ${is} never copied from what anyone in the reference photographs is wearing - not ${pair.plural ? 'their' : 'its'} style, cut or colour.`,
      `Colour of the ${pair.pieces}: ${pair.colour}${pair.exact ? ` (from ${pair.from}) - match it exactly` : ''}.`,
      // Measured: a pallu design ended up on the blouse.
      // Measured: a thin band of the saree's floral border still showed at the
      // blouse's sleeve edges after the blouse itself came out plain.
      `No design reference applies to the ${pair.pieces}. None of the references' motifs, borders, buttis, prints, embroidery, mirror work or zari may appear on ${it} - not even a narrow band or trim at a sleeve edge, neckline or hem.`
    ];
    lines.push(pair.note
      ? `Customer note for the ${pair.pieces}: ${pair.note}. Follow it, but still put no design reference on ${it}.`
      : `The ${pair.pieces} ${is} plain and solid, with neat, simple finishing only, so all attention stays on the ${g.product}.`);
    addText(['WHAT THE MODEL WEARS WITH IT', bullets(lines)].join('\n'));
  }

  // ── 4. DESIGN RULES ────────────────────────────────────────────────────────
  const designRules = [
    'Copy each design exactly, as if following a technical tech-pack: the same motifs, shapes and proportions, the same number and spacing of repeats, and the same technique (woven zari, thread embroidery, mirror work, sequins, stone work, block or digital print) with its real texture and sheen.',
    // Measured: a border reference full of temple (mandir) motifs came back as
    // plain zari stripes. Naming the kinds of motif stops that flattening.
    'Where a reference contains recognisable motifs - temple or mandir outlines, peacocks, paisleys, flowers, vines, animals, figures, geometric jaal or a named weave - those exact motifs must appear in the finished garment at the same scale. Never replace them with generic zari stripes, plain bands or invented filler.',
    // Measured: a pink pallu reference turned the crimson pallu pink, and a navy
    // collar reference turned an ivory collar navy.
    'A design reference supplies the motifs, their layout and the colours OF THE MOTIFS only. The background or ground colour of each part of the garment always comes from that part\'s fabric, never from the design reference\'s own background. If the reference is photographed on a different coloured cloth, reproduce its motifs on the specified fabric colour instead.',
    'A reference image may also show a person, a mannequin, another garment, a background, hands, text or a watermark. Take ONLY the design from it and ignore everything else in that image.',
    'Put each design only in the area it is assigned to, at a realistic scale for that area. Do not enlarge motifs to fill space, and do not spread one area\'s design into other areas unless the garment\'s construction naturally continues it.',
    // Measured: a sleeve reference's roses appeared around the neckline and along
    // the hem of the blouse front, which had its own (white chikankari) reference.
    'Each part shows only its own reference\'s motifs, right up to its seam. Where two parts have different references (a sleeve and a neckline, a border and a body), their motifs, colours and embellishments are never borrowed from one part into the other.',
    'Add nothing that a reference does not show on that part: no extra butis, flowers, pearl or bead drops, fringes, tassels, latkans, lace, piping, sequins or stones.',
    // Measured twice: rose cutwork came out with hearts in it, and - after this line
    // named "hearts" as an example of what not to add - round sequin dots came out
    // as hearts. Naming a shape invites it, so no shape is named here.
    'Every motif keeps exactly the shape it has in its reference: a round dot stays a round dot, a rose stays a rose, a leaf stays a leaf. Lace, cutwork, sequins and embroidery never take on a new or different shape.',
    // Measured: a lilac printed kurti seen through a lace hem band came out behind
    // the lace on a black kurti.
    'Behind lace, net, cutwork, mesh or any other open or sheer work, what shows through is that part\'s own ground colour - never the cloth, print or skin seen through it in the reference photograph.'
  ];
  if (hasGlobal && hasZone) {
    designRules.push('A design assigned to a specific area always wins inside that area. The overall, print or embroidery references apply everywhere else.');
  }
  designRules.push(hasGlobal
    ? 'Do not invent any motif, embellishment, logo or pattern that is not in the references.'
    : 'Do not invent any motif, embellishment, logo or pattern that is not in the references. Parts of the garment with no design reference stay plain in their fabric, with neat, simple finishing only.');
  // Measured in production: a NECK photo's printed sleeves and a FRONT photo's
  // embroidered cuffs were copied onto an anarkali and a suit that had no sleeve design.
  const plainSleeves = taxonomy.getDesignTypes(job.garmentId).some((a) => a.id === 'SLEEVE')
    && !hasGlobal && !designAreas.some((a) => a === 'SLEEVE' || a === 'HAND');
  if (plainSleeves) {
    designRules.push(`The ${g.product} has NO sleeve design: its sleeves are plain fabric from shoulder to wrist - no print, embroidery, buttis, lace or border band on them, not even at the cuff - whatever sleeves the reference photographs show.`);
  }
  addText(['HOW TO USE THE DESIGN REFERENCES', bullets(designRules)].join('\n'));

  // ── 5. FABRIC RULES ────────────────────────────────────────────────────────
  if (job.fabrics.length) {
    const fabricRules = [
      'Tailor the garment from these exact materials. Match each fabric\'s base colour precisely (never warm, cool, brighten or desaturate it), its weave and texture, its surface finish (matte cotton, lustrous silk, satin shine, velvet pile, sheer georgette or chiffon), its transparency, and its weight and the way it falls.',
      'A fabric photo may be a flat swatch, a folded piece or a roll. Show that same material cut and sewn into the garment, with natural folds and drape.',
      'Designs sit on the fabric they belong to and respect its texture: woven zari looks woven into the cloth, prints look printed into the weave, and embroidery sits slightly raised on the surface.',
      // Measured: a dense brocade jaal swatch came back as plain silk once the
      // design (small butis) was applied over it.
      'The fabric\'s own weave stays visible wherever the design does not cover it: if a fabric reference is a brocade, jaal, jacquard, textured or slubbed cloth, that texture must still read across that part of the garment, not be flattened into plain cloth.',
      // Measured the other way round too: a brocade jaal fabric then replaced the
      // multi-coloured butis that the BODY design asked for. Design wins.
       'Where a part has BOTH a design reference and a fabric that carries its own woven pattern, the DESIGN decides what that part looks like: its motifs must be clearly visible at their own size and colours. The fabric\'s own pattern stays behind them as a quieter ground texture and must never replace or crowd out the design\'s motifs.',
      'Where a design\'s motif colours differ from its fabric, keep the design\'s own colours for the motifs and the fabric\'s colour for the ground.'
    ];
    if (job.fabrics.some((f) => f.color || f.colorHex)) {
      fabricRules.push('Where a fabric states a colour or a hex code, that colour is the truth: reproduce it exactly, even if its photograph looks a slightly different shade because of the light it was shot in.');
    }
    if (job.fabrics.some((f) => f.material)) {
      fabricRules.push('Where a fabric states a material, build that part of the garment from that material: its drape, stiffness and sheen must read as that cloth - pure silk falls and shines differently from art silk, net or velvet.');
    }
    const hasMain = job.fabrics.some((f) => !f.appliesTo);
    if (!hasMain) {
      fabricRules.push('Any part of the outfit not covered by a fabric reference uses the most closely related referenced fabric, so the whole outfit reads as one coordinated set.');
    }
    addText(['HOW TO USE THE FABRIC REFERENCES', bullets(fabricRules)].join('\n'));
  } else {
    addText(['FABRIC', 'No fabric reference was given. Choose one premium, realistic fabric whose colour and texture suit the designs best, and use it consistently across the garment.'].join('\n'));
  }

  // ── 6. THE MODEL ───────────────────────────────────────────────────────────
  const modelLines = [];
  if (job.model.kind === 'reference') {
    modelLines.push(`Dress the exact person shown in [Image ${job.model.imageNumber}]. Keep the same face and identity, skin tone, hair, body shape and proportions. Replace only their clothing with the new garment, and ignore their original outfit, pose, background and lighting.`);
  } else {
    modelLines.push(`One professional Indian fashion model: a ${wearerWord} in ${possessive} mid-twenties with natural, healthy skin and a calm, confident expression. Hair is neatly styled away from the neckline, shoulders and back. Jewellery is minimal and elegant and never covers any design. No bag, shawl, jacket, sunglasses or props.`);
  }
  if (pose === 'back') {
    modelLines.push(`Pose: standing${g.framing === 'full' ? ' full length' : ''}, turned three-quarters away from the camera and looking back over the shoulder, so the complete back design is clearly visible while the front silhouette is still readable.`);
  } else {
    modelLines.push(`Pose: standing tall, facing the camera at a slight three-quarter angle, weight on one leg. ${g.poseHint}`);
  }
  // Measured: the jasmine gajra and roses in a reference model's hair were copied.
  modelLines.push('Nothing from the people in the design or fabric reference photographs is copied: not their hairstyle, hair flowers or gajra, jewellery, bindi or makeup. No flowers or accessories in the hair.');
  modelLines.push('Nothing (hair, hands, jewellery or other clothing) may cover any area that has a design reference.');
  addText(['THE MODEL', bullets(modelLines)].join('\n'));

  // ── 7. THE PHOTOGRAPH ──────────────────────────────────────────────────────
  addText(['THE PHOTOGRAPH', bullets([
    framingLine(g),
    'A seamless, plain studio backdrop in soft light warm grey with a smooth floor sweep. No props, furniture, plants, patterns or text.',
    'Soft, even, diffused studio lighting from a large key light with gentle fill, and a soft natural shadow at the feet.',
    'Camera at chest height with a natural 85 mm portrait perspective and no distortion.',
    'Pin-sharp focus on the garment so the weave, thread work and metallic detail are crisp. Neutral white balance so every colour matches the references.'
  ])].join('\n'));

  // Measured: a NECK reference that was a whole peach blouse scattered with teal
  // flowers put those flowers all over a red blouse. When the main fabric is known
  // to be plain and no design covers the whole garment, everything outside the
  // designed parts must be plain too - and that can be checked.
  const mainFabric = job.fabrics.find((f) => !f.appliesTo) || null;
  const mainRead = mainFabric ? descriptions.get(fabricRefNumber(mainFabric)) : null;
  const wholeGarmentDesign = job.designs.some((d) => GLOBAL_AREAS.has(d.areaId) || MAIN_PANEL_AREAS.has(d.areaId) && ['OVERALL', 'PRINT', 'PRINT_PATTERN'].includes(d.areaId));
  const plainRest = mainRead && !patternedFabricFor('__MAIN__') && !wholeGarmentDesign
    ? job.designs.map((d) => partWords(d.areaId, g.product))
    : null;
  // ── 8. QUALITY BAR ─────────────────────────────────────────────────────────
  addText(['QUALITY BAR', bullets([
    'Photorealistic, like a real high-end fashion catalogue shoot. Not an illustration, painting or 3D render.',
    `Exactly one complete ${g.product}, with exactly one of each of its parts. Never show a part twice, never mirror a decorated panel onto the other side, and never add an extra drape, shawl, stole or dupatta that this garment does not have.`,
    // Measured three times in real saree photos: the saree border repeated as gold
    // bands on the blouse sleeves, despite the blouse being described as plain.
    // The final check, right before the image is made, is where it is named.
    // Measured in production: printed sleeves from a NECK photo survived the rule
    // above and one correction. The last word in the prompt carries the most weight.
    // Measured in production: a NECK photo of a kurta sequinned all over covered a
    // whole sharara kurta, and one correction did not undo it.
    ...(plainRest ? [`Final check on the rest of the ${g.product}: only these parts carry a design - ${plainRest.join(', ')}. Everywhere else the ${g.product} is plain fabric: no embroidery, sequins, buttis or print spread there from any reference photograph. If decoration appears outside those parts, remove it.`] : []),
    ...(plainSleeves ? [`Final check on the sleeves of the ${g.product}: if it has sleeves, they are plain ${g.product} fabric from shoulder to wrist, with no print, embroidery, band or motif anywhere on them. If a pattern appears on a sleeve, remove it.`] : []),
    ...(pair ? [`Final check on the ${pair.pieces}: ${pair.plural ? 'they are' : 'it is'} one solid colour from edge to edge. Look at the ${edgesOf(pair.pieces, job.garmentId)}: there is NO gold, zari, metallic or patterned band there. If one appears, remove it.`] : []),
    // Measured again with striped saree references: the band returned on both runs.
    // A perceptual test the model can check works better than naming the band.
    ...(pair && job.garmentId === 'SAREE' ? ['The blouse is sleeveless: its armholes and neckline are finished only with a narrow folded edge of the same plain cloth - no trim, piping, edge line or border of any width or colour.'] : []),
    ...(pair && job.garmentId === 'LEHANGA' ? ['The choli sleeve ends look exactly like the middle of the sleeve: the same plain cloth, the same colour, no stripe or band of any kind, finished only with a narrow folded hem of that same cloth - no trim, piping, edge line or border of any width or colour.'] : []),
    'Correct garment construction and believable fabric physics: real seams, folds and drape weight.',
    `Anatomically correct face, hands, fingers${g.framing === 'full' ? ' and feet' : ''}. Exactly one person in the frame.`,
    'No collage, split screen, inset swatches, mannequin, duplicated limbs, text, watermark, logo or brand name anywhere in the image.'
  ])].join('\n'));

  // ── 9. CUSTOMER NOTES ──────────────────────────────────────────────────────
  if (job.notes) {
    addText(['CUSTOMER NOTES', `The customer also asked: "${clean(job.notes)}". Follow this unless it contradicts the reference images or the rules above.`].join('\n'));
  }

  addText('Return only the finished photograph.');

  const areasSent = new Set(job.designs.map((d) => d.areaId));
  Object.assign(review, {
    plainRest,
    plainSleeves,
    product: g.product,
    garmentId: job.garmentId,
    framing: g.framing,
    pose,
    pair: pair ? { pieces: pair.pieces, colour: pair.colour, edges: edgesOf(pair.pieces, job.garmentId) } : null,
    noDupatta: !areasSent.has('DUPATTA') && job.garmentId !== 'DUPATTA' && job.garmentId !== 'LEHANGA',
    noTassels: (job.garmentId === 'DUPATTA' && !areasSent.has('TASSEL')) || job.garmentId === 'SAREE',
    onePallu: job.garmentId === 'SAREE',
    fabricColours: job.fabrics.filter((f) => f.color || f.colorHex).map((f) => ({ name: f.name, colour: [f.color, f.colorHex].filter(Boolean).join(' '), appliesTo: f.appliesTo || 'MAIN' }))
  });
  return { parts, text: textLog.join('\n\n'), warnings, pose, framing: g.framing, imageCount: n, review };
}

module.exports = { buildPrompt, referenceList, pairing, DEFAULT_PAIRING_COLOUR, backgroundColourOf, referenceGroundOf, printKind };
