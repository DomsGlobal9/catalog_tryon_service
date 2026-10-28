// =============================================================================
// sketch.js — POST /sketch: a hand-drawn dress sketch with labelled colours,
// made into a real photograph of the finished garment (since 28 Oct 2026).
// =============================================================================
//
// The owner's decisions (28 Oct 2026):
//   - ONE call: the drawing is read and the photograph made in the same request.
//     What was read (garment, every label and the part it points to) is sent to
//     the caller as a `reading` event before the photograph, so the app can show
//     it; a misread label is corrected by sending the request again with `labels`.
//   - the FRONT always; the BACK only when the back is drawn (on the same sheet,
//     or as a second picture, `backSketch`). An undrawn back would be invented.
//   - fabric and design pictures may be sent with the sketch (same fields as
//     /generate); a fabric picture beats a colour word.
//
// Three steps, the same shape as /generate:
//   1. read      one text-model call: what garment, which views are drawn, the
//                silhouette, and every label with the part its line points to;
//   2. make      the image model gets the sketch as the shape and the labels as
//                the colour and material of each part (+ fabrics, designs);
//   3. check     the shape matches the sketch, each labelled part has its colour,
//                no pencil, arrows or handwriting left, one person (or none on a
//                mannequin); redone once with the faults named.
// A caller's own photo goes through the same two steps as /generate: the garment
// on a mannequin first, then dressed onto the photo (drapeOnPerson.makeDresser).
//
const { z } = require('zod');
const { config } = require('./config');
const { StudioError, validation, redact } = require('./errors');
const { garmentGuide, describeArea, taxonomy } = require('./garmentGuide');
const { framingLine } = require('./promptBuilder');
const { askInspector, RESPONSE_SCHEMA } = require('./qualityCheck');
const {
  canonicaliseFields, resolveParts, resolvePerson, formatZodIssues, canonicalPresentation,
  designItem, fabricItem, pairWithItem, hexField, text, imageField, MODEL_GENDERS, classifyImage
} = require('./validate');

let fetchImpl = (...args) => fetch(...args);

const MAX_LABELS = 20;
// What a sketch can be shown as. A sketch made into a sketch is pointless.
const SKETCH_PRESENTATIONS = ['model', 'mannequin'];

// ── 1. The request ───────────────────────────────────────────────────────────
const labelItem = z.object({
  part: text(60).min(1, 'must name the part, such as "skirt" or "border"'),
  color: text(60).optional(),
  colorHex: hexField('#800000').optional(),
  material: text(120).optional(),
  work: text(200).optional()
}).strict();

const sketchSchema = z.object({
  clientId: z.string().trim().min(1).max(128),
  sketch: imageField,
  backSketch: imageField.optional(),
  // Optional: read from the drawing when left out.
  garment: z.string().trim().min(1).max(40).optional(),
  productName: text(120).optional(),
  // Corrections to the reading, by part: they replace what was read for that part.
  labels: z.array(labelItem).max(MAX_LABELS, `at most ${MAX_LABELS} labels`).optional(),
  designs: z.array(designItem).max(config.limits.maxDesigns, `at most ${config.limits.maxDesigns} designs`).default([]),
  fabrics: z.array(fabricItem).max(config.limits.maxFabrics, `at most ${config.limits.maxFabrics} fabrics`).default([]),
  modelImage: imageField.optional(),
  modelGender: z.enum(MODEL_GENDERS).optional(),
  pairWith: pairWithItem.optional(),
  presentation: z.preprocess(canonicalPresentation, z.string()).optional(),
  notes: text(config.limits.maxNotesChars).optional()
}).strict();

const pick = (obj, from, to) => {
  if (obj[from] !== undefined && obj[to] === undefined) obj[to] = obj[from];
  if (from !== to) delete obj[from];
};

/** The sketch request as a job, or a 400. Nothing is downloaded here. */
function resolveSketchRequest(rawBody) {
  const inputWarnings = [];
  const body = canonicaliseFields(rawBody === undefined ? {} : rawBody, inputWarnings);
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const k of ['sketch_image', 'sketchImage', 'sketchUrl', 'sketch_url', 'drawing']) pick(body, k, 'sketch');
    for (const k of ['back_sketch', 'backSketchImage', 'back_sketch_image', 'backSketchUrl', 'back_sketch_url']) pick(body, k, 'backSketch');
    if (Array.isArray(body.labels)) {
      body.labels = body.labels.map((l) => {
        if (!l || typeof l !== 'object' || Array.isArray(l)) return l;
        const label = { ...l };
        pick(label, 'colour', 'color');
        pick(label, 'color_hex', 'colorHex');
        pick(label, 'colourHex', 'colorHex');
        pick(label, 'fabric', 'material');
        pick(label, 'embroidery', 'work');
        return label;
      });
    }
  }
  const parsed = sketchSchema.safeParse(body);
  if (!parsed.success) {
    const issues = formatZodIssues(parsed.error);
    throw validation(`Invalid request: ${issues.map((i) => `${i.field} ${i.message}`).join('; ')}`, issues);
  }
  const input = parsed.data;

  let garment = null;
  if (input.garment) {
    garment = taxonomy.getGarment(input.garment);
    if (!garment) {
      throw validation(`Unknown garment "${input.garment}". Use one of: ${taxonomy.GARMENT_IDS.join(', ')}, or leave it out to read it from the sketch.`,
        [{ field: 'garment', code: 'UNKNOWN_GARMENT' }]);
    }
  }
  const presentation = input.presentation || 'model';
  if (!SKETCH_PRESENTATIONS.includes(presentation)) {
    throw validation(presentation === 'sketch'
      ? 'This endpoint makes a sketch into a photograph, so presentation "sketch" is not available here. Use "model" or "mannequin".'
      : `presentation must be one of ${SKETCH_PRESENTATIONS.join(', ')}.`, [{ field: 'presentation', code: 'PRESENTATION_NOT_AVAILABLE' }]);
  }
  if (presentation !== 'model' && input.modelImage) {
    throw validation(`modelImage dresses a real person, so it cannot be used with presentation "${presentation}". Send it with presentation "model", or leave it out.`,
      [{ field: 'modelImage', code: 'PRESENTATION_CONFLICT' }]);
  }
  const sketches = [{ view: 'front', field: 'sketch', source: classifyImage(input.sketch, 'sketch') }];
  if (input.backSketch) sketches.push({ view: 'back', field: 'backSketch', source: classifyImage(input.backSketch, 'backSketch') });
  const { designs, fabrics } = resolveParts(input, garment);

  return {
    endpoint: 'sketch',
    presentation,
    inputWarnings,
    clientId: input.clientId,
    productName: input.productName || null,
    garmentId: garment ? garment.id : null,
    garmentName: garment ? garment.name : null,
    sketches,
    labels: (input.labels || []).map((l) => ({
      part: l.part,
      color: l.color || null,
      colorHex: l.colorHex ? `#${l.colorHex.replace('#', '').toUpperCase()}` : null,
      material: l.material || null,
      work: l.work || null
    })),
    designs,
    fabrics,
    ...resolvePerson(input, garment)
  };
}

// ── 2. Reading the sketch ────────────────────────────────────────────────────
const READ_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isSketch: { type: 'BOOLEAN' },
    garment: { type: 'STRING' },
    views: { type: 'OBJECT', properties: { front: { type: 'BOOLEAN' }, back: { type: 'BOOLEAN' } }, required: ['front', 'back'] },
    silhouette: { type: 'STRING' },
    parts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' }, part: { type: 'STRING' }, color: { type: 'STRING' }, colorHex: { type: 'STRING' },
          material: { type: 'STRING' }, work: { type: 'STRING' }
        },
        required: ['label', 'part', 'color'],
        propertyOrdering: ['label', 'part', 'color', 'colorHex', 'material', 'work']
      }
    },
    notes: { type: 'ARRAY', items: { type: 'STRING' } },
    unreadable: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['isSketch', 'garment', 'views', 'silhouette', 'parts', 'notes', 'unreadable'],
  propertyOrdering: ['isSketch', 'garment', 'views', 'silhouette', 'parts', 'notes', 'unreadable']
};

function readingPrompt(job) {
  const garments = taxonomy.GARMENTS.map((g) => `${g.id} (${g.name})`).join(', ');
  const back = job.sketches.find((s) => s.view === 'back');
  return [
    'You read a fashion designer\'s hand-drawn sketch of one Indian garment, so that it can be made exactly as drawn.',
    back ? 'SKETCH 1 is the front of the garment; SKETCH 2 is its back.' : 'SKETCH 1 may show the front only, or the front and the back side by side.',
    '',
    '- isSketch: true for a drawing of a garment (pencil, ink, marker, paint, or drawn on a tablet). false for a photograph of a real garment, or a picture that is not a garment drawing at all.',
    `- garment: the one garment drawn, as one of these ids: ${garments}. A saree drawn with its blouse is SAREE; a lehenga with its choli and dupatta is LEHANGA. UNKNOWN if it is none of them.${job.garmentId ? ` The customer says it is ${job.garmentId}.` : ''}`,
    '- views.front / views.back: which sides of the garment are drawn. back is true only when the back of the garment itself is drawn (a figure seen from behind, or a drawing of the back) - never assume it.',
    '- silhouette: one or two sentences on the shape as drawn: neckline shape and depth, sleeves (sleeveless, cap, elbow, full), waist, length, fit and flare, panels, slits, ties, closures, layers. Only what is drawn.',
    '- parts: one entry per label written on the sketch. label = the words exactly as written, spelling and all (do not correct them). part = the part of the garment that label\'s arrow, line or position points to, in plain words ("skirt", "blouse sleeves", "border of the dupatta"). color = the colour the label names; when the label names no colour but the drawing is coloured there, the drawn colour. colorHex = your best 6-digit hex for that colour ("maroon" -> #800000). material = the fabric named ("raw silk", "net", "georgette"), else empty. work = the embellishment named ("gold zari border", "mirror work", "stone work"), else empty.',
    '- When the drawing is coloured in but a part has no label, add an entry for that part with label "" and its drawn colour.',
    '- notes: any other writing on the sketch that describes the garment (for example "length till ankle", "deep back"), exactly as written. Not names, dates or signatures.',
    '- unreadable: every label or note you cannot read with confidence, as you see it (for example "m?r??n silk"). Never guess a word into a part.'
  ].join('\n');
}

const asText = (v) => (typeof v === 'string' ? v.trim() : '');
const HEX = /^#?[0-9a-fA-F]{6}$/;

/** Tidy one reading from the model; anything malformed is left out rather than trusted. */
function cleanReading(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const garment = taxonomy.getGarment(asText(raw.garment)) || null;
  const views = raw.views && typeof raw.views === 'object' ? raw.views : {};
  const parts = (Array.isArray(raw.parts) ? raw.parts : [])
    .filter((p) => p && typeof p === 'object' && asText(p.part))
    .slice(0, MAX_LABELS)
    .map((p) => ({
      label: asText(p.label),
      part: asText(p.part).slice(0, 60),
      color: asText(p.color).slice(0, 60) || null,
      colorHex: HEX.test(asText(p.colorHex)) ? `#${asText(p.colorHex).replace('#', '').toUpperCase()}` : null,
      material: asText(p.material).slice(0, 120) || null,
      work: asText(p.work).slice(0, 200) || null,
      from: 'sketch'
    }));
  return {
    isSketch: raw.isSketch !== false,
    garmentId: garment ? garment.id : null,
    views: { front: true, back: views.back === true },
    silhouette: asText(raw.silhouette).slice(0, 600) || null,
    parts,
    notes: (Array.isArray(raw.notes) ? raw.notes : []).map(asText).filter(Boolean).slice(0, 10),
    unreadable: (Array.isArray(raw.unreadable) ? raw.unreadable : []).map(asText).filter(Boolean).slice(0, 10)
  };
}

/**
 * One call to the text model, retried once. Never throws except on cancel.
 * @returns {Promise<{ reading: Object|null, problem: string|null }>}
 */
async function readSketch(job, { signal } = {}) {
  if (!config.gemini.apiKey()) return { reading: null, problem: 'no API key' };
  const parts = [{ text: readingPrompt(job) }];
  job.sketches.forEach((s, i) => parts.push({ text: `SKETCH ${i + 1} (${s.view}):` }, { inlineData: { mimeType: s.image.mimeType, data: s.image.base64 } }));
  let problem = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const timeout = AbortSignal.timeout(config.describe.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(`${config.gemini.baseUrl}/models/${encodeURIComponent(config.describe.model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey() },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: READ_SCHEMA,
            maxOutputTokens: 4096,
            // Handwriting is worth a little thinking.
            ...(/2\.5/.test(config.describe.model) ? { thinkingConfig: { thinkingBudget: 1024 } } : {})
          }
        }),
        signal: combined
      });
      if (!response.ok) { problem = `HTTP ${response.status} ${redact(await response.text().catch(() => '')).slice(0, 120)}`; continue; }
      const json = await response.json();
      const candidate = (json.candidates || [])[0];
      const answer = ((candidate && candidate.content && candidate.content.parts) || [])
        .filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
      let raw = null;
      try { raw = JSON.parse(answer.replace(/```(?:json)?/gi, '').trim()); } catch { raw = null; }
      const reading = cleanReading(raw);
      if (reading) return { reading, problem: null };
      problem = 'answer was not usable JSON';
    } catch (err) {
      if (signal && signal.aborted) throw new StudioError('Request cancelled.', { status: 499, code: 'CANCELLED' });
      problem = redact(err && err.message);
    }
  }
  return { reading: null, problem };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The caller's corrections replace what was read for the same part; new parts are added. */
function mergeLabels(read, overrides) {
  const out = read.map((p) => ({ ...p }));
  for (const o of overrides || []) {
    const i = out.findIndex((p) => norm(p.part) === norm(o.part));
    const entry = { label: i >= 0 ? out[i].label : '', part: o.part, color: o.color, colorHex: o.colorHex, material: o.material, work: o.work, from: 'you' };
    if (i >= 0) {
      // Only what the caller says replaces the reading; the rest of what was read stays.
      for (const k of ['color', 'colorHex', 'material', 'work']) if (!entry[k]) entry[k] = out[i][k];
      if (o.color && !o.colorHex) entry.colorHex = null; // a new colour word: the old hex no longer fits it
      out[i] = entry;
    } else {
      out.push(entry);
    }
  }
  return out;
}

/** "the skirt: maroon (#800000) raw silk, with gold zari border" */
function partLine(p) {
  const colour = p.color ? `${p.color}${p.colorHex ? ` (${p.colorHex})` : ''}` : (p.colorHex || null);
  const what = [colour, p.material].filter(Boolean).join(' ');
  return `the ${p.part}: ${what || 'as drawn'}${p.work ? `, with ${p.work}` : ''}`;
}

// ── 3. The photograph ────────────────────────────────────────────────────────
/**
 * @param {Object} job       the resolved sketch job (garmentId known by now)
 * @param {Object} o
 * @param {Object} o.reading  cleanReading() output
 * @param {Object[]} o.parts  mergeLabels() output
 * @param {'front'|'back'} o.view
 * @param {Object} [o.frontPhoto]  the finished front view, for the back
 * @param {'model'|'mannequin'} o.presentation
 */
function buildSketchPrompt(job, { reading, parts, view, frontPhoto = null, presentation }) {
  const g = garmentGuide(job.garmentId);
  const onMannequin = presentation === 'mannequin';
  const wearer = (job.model.gender || g.wearer) === 'male' ? 'man' : 'woman';
  const images = [];
  const add = (label, image) => { images.push({ label, image }); return images.length; };

  const backSketch = job.sketches.find((s) => s.view === 'back');
  const front = job.sketches.find((s) => s.view === 'front');
  const sketchNo = add('SKETCH - the design to make', view === 'back' && backSketch ? backSketch.image : front.image);
  // The back view also sees the front sketch when the back was drawn on its own sheet.
  const frontSketchNo = view === 'back' && backSketch ? add('FRONT SKETCH - the same garment from the front', front.image) : null;
  const fabricLines = job.fabrics.map((f) => {
    const n = add(`FABRIC for ${f.appliesTo ? f.appliesTo.join(', ') : 'the main body'}`, f.image);
    const where = f.appliesTo ? f.appliesTo.map((a) => describeArea(job.garmentId, a)).join('; ') : `the main body of the ${g.product}`;
    return `[Image ${n}] is the fabric for ${where}: its exact colour, weave, texture and sheen${f.material ? ` (${f.material})` : ''}. A fabric picture beats a colour word on the sketch.`;
  });
  const designLines = job.designs.map((d) => {
    const n = add(`DESIGN for ${d.areaId}`, d.image);
    return `[Image ${n}] is the motif, embroidery or print for ${describeArea(job.garmentId, d.areaId)}: put it there only, at a realistic scale for the garment${d.note ? `. ${d.note}` : ''}.`;
  });
  const frontNo = view === 'back' && frontPhoto ? add('FRONT VIEW - the finished garment from the front', frontPhoto) : null;

  const coloured = parts.some((p) => !p.label && p.color);
  const largest = parts.find((p) => p.color);
  const subject = onMannequin
    ? `on a headless dress-form mannequin on a stand (no person, no head, no hands)`
    : `worn by one professional Indian fashion model, a ${wearer} in ${wearer === 'man' ? 'his' : 'her'} mid-twenties`;

  const lines = [
    'TASK',
    `Make the designer's hand-drawn sketch [Image ${sketchNo}] into a real photograph of the finished ${g.product}, made exactly as drawn and labelled, ${subject}, in a seamless plain light-grey studio with soft, even catalogue lighting.`,
    '',
    'THE SKETCH IS THE DESIGN',
    `- Its shape is the garment's shape: ${reading.silhouette ? `${reading.silhouette} ` : ''}The same neckline shape and depth, the same sleeves (or none), the same waist, length, fit, flare and volume.`,
    '- Every panel, seam, yoke, border, slit, pleat, tie, layer and closure that is drawn is there, in the same place and in the same proportion to the body. Nothing that is not drawn is added: no extra layer, jacket, dupatta, trim or border.',
    '- Sketches stretch the body (long legs, a tiny waist). Keep the design\'s proportions relative to the body, on a natural, real body.',
    '- The photograph is of the made garment only: no pencil or ink lines, no arrows, no handwriting or label text, no paper, and no part of the sketch itself.',
    '',
    'THE LABELS - written on the sketch; they set the colour and material of each part',
    ...(parts.length ? parts.map((p) => `- ${partLine(p)}`) : ['- (no labels were written)']),
    `- Each labelled part is exactly its colour from edge to edge, in the named material. Where a part has no label, it is ${coloured ? 'the colour drawn on the sketch there' : `in the garment's main colour${largest ? ` (${largest.color})` : ''}`}.`,
    ...(reading.notes.length ? ['', 'WRITTEN ON THE SKETCH', ...reading.notes.map((n) => `- "${n}"`)] : []),
    ...(fabricLines.length ? ['', 'FABRICS', ...fabricLines.map((l) => `- ${l}`)] : []),
    ...(designLines.length ? ['', 'DESIGNS', ...designLines.map((l) => `- ${l}`)] : []),
    '',
    'THE GARMENT',
    `${g.outfit} Where the sketch does not show something, make it the way a ${g.product} is properly made${g.construction ? `: ${g.construction.join(' ')}` : '.'} Where the sketch shows it, the sketch wins.`,
    ...(job.pairWith ? [`What is worn with it and not drawn on the sketch: ${[job.pairWith.color, job.pairWith.colorHex].filter(Boolean).join(' ')}${job.pairWith.note ? `, ${job.pairWith.note}` : ''}.`] : []),
    ...(job.notes ? ['', 'THE CUSTOMER SAYS', job.notes] : []),
    ''
  ];

  if (view === 'back') {
    lines.push('THIS IS THE BACK VIEW',
      `- Show the back of this exact ${g.product}, made as drawn in ${backSketch ? `the back sketch [Image ${sketchNo}] (the front is [Image ${frontSketchNo}])` : `the back figure of the sketch [Image ${sketchNo}]`}.`,
      ...(frontNo ? [`- [Image ${frontNo}] is the front of the same garment, already made: the same fabric, colours, borders, work, length and sleeves. Every part seen in both looks exactly the same.`] : []),
      onMannequin
        ? '- The same mannequin, turned so its back faces the camera.'
        : `- The same model, standing with ${wearer === 'man' ? 'his' : 'her'} back squarely to the camera, the head facing away; hair brought forward over one shoulder; arms relaxed at the sides; nothing covers the back of the garment.`,
      '');
  }

  lines.push('THE PHOTOGRAPH',
    onMannequin
      ? `A catalogue photograph in ${config.gemini.aspectRatio} of the dressed form and its stand, the whole ${g.product} inside the frame, nothing cropped.`
      : framingLine(g),
    ...(onMannequin || view === 'back' ? [] : [`Pose: standing naturally, facing the camera, arms relaxed so nothing covers the ${g.product}.`]),
    '',
    'QUALITY BAR',
    '- Photorealistic, like a real high-end fashion catalogue photograph. Not an illustration, painting, sketch or 3D render.',
    '- Real fabric with weight, folds and fine wrinkles; correct garment construction with real seams.',
    onMannequin
      ? '- Exactly one mannequin and no person.'
      : '- Exactly one person, with an anatomically correct face, hands and fingers.',
    '- No text, watermark, logo, collage or inset anywhere in the image.');

  const text = lines.join('\n');
  const geminiParts = [{ text }];
  images.forEach((img, i) => geminiParts.push({ text: `[Image ${i + 1}] ${img.label}:` }, { inlineData: { mimeType: img.image.mimeType, data: img.image.base64 } }));
  return {
    text,
    parts: geminiParts,
    review: { product: g.product, garmentId: job.garmentId, view, presentation, parts, sketchImage: images[sketchNo - 1].image, frontPhoto }
  };
}

// ── 4. The checks ────────────────────────────────────────────────────────────
function sketchChecklist(review) {
  const product = review.product;
  const checks = [
    ['shape_as_drawn', `Ignoring colour: does the ${product} in the PHOTOGRAPH have the shape drawn in the SKETCH${review.view === 'back' ? ' (its back)' : ''} - the same neckline shape and depth, the same sleeves (or none), the same length, fit and flare, and the same panels, borders and layers in the same places - with nothing added that is not drawn?`,
      `The ${product} has exactly the shape drawn in the sketch: the same neckline shape and depth, the same sleeves (or none), the same length, fit and flare, the same panels, borders and layers in the same places, and nothing added that is not drawn.`]
  ];
  review.parts.filter((p) => p.color || p.material || p.work).slice(0, 10).forEach((p, i) => {
    const colour = p.color ? `${p.color}${p.colorHex ? ` (about ${p.colorHex})` : ''}` : null;
    const what = [colour, p.material, p.work ? `with ${p.work}` : null].filter(Boolean).join(', ');
    // Letters, like every other check id (the inspector answers by id).
    checks.push([`label_${String.fromCharCode(97 + i)}`, `Is the ${p.part} ${what}?`, `The ${p.part} is ${what}, as labelled on the sketch.`]);
  });
  checks.push(['no_sketch_marks', 'Is the PHOTOGRAPH a clean, real photograph - with no pencil or ink lines, arrows, handwriting, label text, paper texture or pieces of the sketch anywhere in it?',
    'A clean, real photograph: no pencil or ink lines, arrows, handwriting, label text, paper or any part of the sketch.']);
  if (review.view === 'back') {
    checks.push(['back_shown', `Does the PHOTOGRAPH show the back of the ${product} squarely to the camera, with the whole back visible and nothing covering it?`,
      `The back of the ${product} faces the camera squarely and is completely visible.`]);
    if (review.frontPhoto) {
      checks.push(['same_as_front', `Is it the same ${product} as in the FRONT view - the same fabric colours, borders, work, length and sleeves?`,
        `The same ${product} as the front view: the same fabric colours, borders, work, length and sleeves.`]);
    }
  }
  checks.push(review.presentation === 'mannequin'
    ? ['no_person', `Is the ${product} on a headless dress-form mannequin, with no person, head, face or hands anywhere in the PHOTOGRAPH?`, `Show the ${product} on a headless dress-form mannequin on a stand: no person, no head, no face, no hands.`]
    : ['one_person', 'Is there exactly one person in the PHOTOGRAPH - not the same person twice, and no second figure, reflection or mannequin?', 'Show exactly ONE person, once.']);
  return checks.map(([id, question, correction]) => ({ id, question, correction }));
}

/** One inspector call. @returns {{ checked, failures, problem? }} - never throws except on cancel. */
async function reviewSketchPhoto(review, image, { signal } = {}) {
  const checklist = sketchChecklist(review);
  const unchecked = (problem) => ({ checked: false, failures: [], problem });
  if (!config.pair.enabled || !config.gemini.apiKey()) return unchecked('disabled');
  const text = [
    `You are the quality inspector for a fashion catalogue. The PHOTOGRAPH should be the ${review.view} view of a ${review.product} made from the designer's hand-drawn SKETCH, in the colours and materials written on it${review.frontPhoto && review.view === 'back' ? '; the FRONT picture is the front view of the same garment, already approved' : ''}.`,
    'Answer each check strictly: pass=true only when it is clearly satisfied. When something differs, answer pass=false and say what differs in evidence (under 25 words).',
    'Answer every check, using its id.',
    '',
    ...checklist.map((c) => `- ${c.id}: ${c.question}`)
  ].join('\n');
  const parts = [{ text }, { text: 'PHOTOGRAPH:' }, { inlineData: { mimeType: image.mimeType, data: image.base64 } },
    { text: 'SKETCH:' }, { inlineData: { mimeType: review.sketchImage.mimeType, data: review.sketchImage.base64 } }];
  if (review.frontPhoto && review.view === 'back') parts.push({ text: 'FRONT view:' }, { inlineData: { mimeType: review.frontPhoto.mimeType, data: review.frontPhoto.base64 } });
  try {
    const asked = await askInspector(parts, RESPONSE_SCHEMA, signal);
    if (asked.problem) return unchecked(asked.problem);
    const parsed = asked.parsed;
    if (!parsed || !Array.isArray(parsed.checks)) return unchecked('answer was not usable JSON');
    const byId = new Map(parsed.checks.filter((c) => c && typeof c.id === 'string').map((c) => [c.id.trim(), c]));
    if (checklist.every((c) => !byId.has(c.id))) return unchecked('answer matched no check');
    const failures = checklist.filter((c) => byId.has(c.id) && byId.get(c.id).pass === false)
      .map((c) => ({ id: c.id, evidence: String(byId.get(c.id).evidence || '').slice(0, 200), correction: c.correction }));
    return { checked: true, failures };
  } catch (err) {
    if (signal && signal.aborted) throw err;
    return unchecked(redact(err && err.message));
  }
}

module.exports = {
  resolveSketchRequest, readSketch, cleanReading, mergeLabels, buildSketchPrompt, sketchChecklist, reviewSketchPhoto,
  READ_SCHEMA, MAX_LABELS, SKETCH_PRESENTATIONS, _setFetch: (fn) => { fetchImpl = fn; }
};
