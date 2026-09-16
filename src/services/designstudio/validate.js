// =============================================================================
// validate.js — turn a request body into a clean, fully resolved job, or refuse.
// =============================================================================
//
// Three layers:
//   1. field names: two spellings of the same request are accepted, so a caller
//      built around a product catalogue ("productType", "parts",
//      "designImageUrl", "fabrics[].details") works as well as the short form
//      ("garment", "designs", "image"). See canonicaliseFields below.
//   2. shape (zod): types, lengths, counts, no unknown fields;
//   3. meaning: the garment exists, every design area belongs to that garment,
//      fabric assignments do not overlap, every image is base64 or an allowed link.
//
// Nothing is downloaded or decoded here - that is imageInput.js, after this has
// passed - so a malformed request costs nothing.
//
const { z } = require('zod');
const { config } = require('./config');
const { validation } = require('./errors');
const { taxonomy, garmentGuide } = require('./garmentGuide');

const MODEL_GENDERS = ['female', 'male'];

const text = (max) => z.string().trim().max(max);
const imageField = z.string({ error: 'must be a base64 image or an https link' }).trim().min(1, 'must not be empty');

// ── 1. Field names ───────────────────────────────────────────────────────────
//
// Accepted spelling -> what the service calls it:
//   productType | garmentType -> garment     instructions -> notes
//   parts -> designs                         parts[].type -> area
//   parts[].designImageUrl | imageUrl -> image        parts[].description -> note
//   fabrics[].imageUrl -> image              fabrics[].details.* -> flattened
//   colour -> color                          modelImageUrl -> modelImage
//   pairedWith -> pairWith                   pairWith.colour -> color
//
// Accepted and then ignored, because they cannot change a photograph:
//   quantityMeters (stock), parts[].label (a caller's own display name).
//
const pick = (obj, from, to) => {
  if (obj[from] !== undefined && obj[to] === undefined) obj[to] = obj[from];
  if (from !== to) delete obj[from];
};

function canonicaliseFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const body = { ...raw };
  pick(body, 'productType', 'garment');
  pick(body, 'garmentType', 'garment');
  pick(body, 'instructions', 'notes');
  pick(body, 'parts', 'designs');
  pick(body, 'modelImageUrl', 'modelImage');
  pick(body, 'pairedWith', 'pairWith');

  if (body.pairWith && typeof body.pairWith === 'object' && !Array.isArray(body.pairWith)) {
    const pair = { ...body.pairWith };
    pick(pair, 'colour', 'color');
    pick(pair, 'colourHex', 'colorHex');
    pick(pair, 'description', 'note');
    body.pairWith = pair;
  }

  if (Array.isArray(body.designs)) {
    body.designs = body.designs.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const design = { ...entry };
      pick(design, 'type', 'area');
      pick(design, 'designImageUrl', 'image');
      pick(design, 'imageUrl', 'image');
      pick(design, 'description', 'note');
      pick(design, 'groundColour', 'groundColor');
      pick(design, 'groundColourHex', 'groundColorHex');
      pick(design, 'keepMotifColours', 'keepMotifColors');
      return design;
    });
  }

  if (Array.isArray(body.fabrics)) {
    body.fabrics = body.fabrics.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const fabric = { ...entry };
      pick(fabric, 'imageUrl', 'image');
      pick(fabric, 'fabricImageUrl', 'image');
      if (fabric.details && typeof fabric.details === 'object' && !Array.isArray(fabric.details)) {
        const details = fabric.details;
        delete fabric.details;
        // Every key is lifted out, not just the ones we use: a typo inside
        // details (colourHex, materail) then fails the strict check below with
        // the field named, instead of being silently ignored.
        for (const key of Object.keys(details)) {
          if (details[key] !== undefined && fabric[key] === undefined) fabric[key] = details[key];
        }
      }
      pick(fabric, 'colour', 'color');
      pick(fabric, 'description', 'note');
      return fabric;
    });
  }
  return body;
}

// ── 2. Shape ─────────────────────────────────────────────────────────────────
const schema = z.object({
  clientId: z.string().trim().min(1).max(128),
  garment: z.string().trim().min(1).max(40),
  // A style hint only ("Bridal Banarasi Saree"). No text is ever drawn into the photo.
  productName: text(120).optional(),
  designs: z.array(z.object({
    area: z.string().trim().min(1).max(40),
    image: imageField,
    note: text(config.limits.maxNoteChars).optional(),
    label: text(80).optional(), // the caller's display name; not used in the prompt
    // Per-part control, for when the reference photo and the intended product
    // disagree. All optional; the defaults are what the earlier tests needed.
    groundColor: text(60).optional(),
    groundColorHex: z.string().trim().regex(/^#?[0-9a-fA-F]{6}$/, 'must be a 6-digit hex colour such as #F2E8DC').optional(),
    keepMotifColors: z.boolean().optional(), // default true: motif colours come from the reference
    coverage: z.enum(['full', 'reference']).optional() // default full: no large bare gaps in a decorated part
  }).strict()).min(1, 'at least one design is required').max(config.limits.maxDesigns, `at most ${config.limits.maxDesigns} designs`),
  fabrics: z.array(z.object({
    image: imageField,
    name: text(80).optional(),
    material: text(120).optional(),
    color: text(60).optional(),
    colorHex: z.string().trim().regex(/^#?[0-9a-fA-F]{6}$/, 'must be a 6-digit hex colour such as #722F37').optional(),
    itemCode: text(40).optional(),
    appliesTo: z.array(z.string().trim().min(1).max(40)).min(1).max(20).optional(),
    note: text(config.limits.maxNoteChars).optional(),
    quantityMeters: z.number().nonnegative().optional() // stock information; ignored
  }).strict()).max(config.limits.maxFabrics, `at most ${config.limits.maxFabrics} fabrics`).default([]),
  modelImage: imageField.optional(),
  // The supporting pieces worn with the product (a saree's blouse, a blouse's
  // saree). They never carry a design; this only sets their colour and look.
  pairWith: z.object({
    color: text(60).optional(),
    colorHex: z.string().trim().regex(/^#?[0-9a-fA-F]{6}$/, 'must be a 6-digit hex colour such as #C9A227').optional(),
    note: text(config.limits.maxNoteChars).optional()
  }).strict().optional(),
  modelGender: z.enum(MODEL_GENDERS).optional(),
  notes: text(config.limits.maxNotesChars).optional()
}).strict();

const DATA_URI = /^data:image\/(png|jpe?g|webp|avif|heic|heif|gif|tiff?);base64,/i;
const BASE64_BODY = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Classify one image string without decoding it.
 * @returns {{ kind: 'base64', data: string } | { kind: 'url', url: URL }}
 */
function classifyImage(value, field) {
  if (/^https?:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw validation(`${field} is not a valid link.`, [{ field, code: 'INVALID_URL' }]);
    }
    if (url.protocol !== 'https:') {
      throw validation(`${field} must use https.`, [{ field, code: 'INSECURE_URL' }]);
    }
    if (url.username || url.password) {
      throw validation(`${field} must not contain credentials.`, [{ field, code: 'INVALID_URL' }]);
    }
    if (!hostAllowed(url.hostname)) {
      throw validation(`${field} must be base64 or a Cloudinary link (${config.input.allowedHosts.join(', ')}).`,
        [{ field, code: 'IMAGE_SOURCE_NOT_ALLOWED', host: url.hostname }]);
    }
    return { kind: 'url', url };
  }

  const body = value.replace(DATA_URI, '').replace(/\s+/g, '');
  if (body.length < 64 || !BASE64_BODY.test(body)) {
    throw validation(`${field} must be a base64 image (optionally a data:image/...;base64, URI) or an https Cloudinary link.`,
      [{ field, code: 'INVALID_IMAGE_ENCODING' }]);
  }
  if (Math.floor(body.length * 3 / 4) > config.limits.maxImageBytes) {
    throw validation(`${field} is larger than ${config.limits.maxImageBytes / 1024 / 1024} MB.`, [{ field, code: 'IMAGE_TOO_LARGE' }]);
  }
  return { kind: 'base64', data: body };
}

function hostAllowed(hostname) {
  const host = hostname.toLowerCase();
  return config.input.allowedHosts.some((allowed) =>
    host === allowed || (allowed === 'res.cloudinary.com' && /^res-\d+\.cloudinary\.com$/.test(host)));
}

function formatZodIssues(error) {
  return error.issues.map((issue) => ({
    field: issue.path.length ? issue.path.join('.').replace(/\.(\d+)/g, '[$1]') : '(body)',
    code: 'INVALID_FIELD',
    message: issue.message
  }));
}

/**
 * @returns {Object} a resolved job: canonical garment, resolved areas, classified images.
 * @throws StudioError 400
 */
function resolveRequest(rawBody) {
  const parsed = schema.safeParse(canonicaliseFields(rawBody === undefined ? {} : rawBody));
  if (!parsed.success) {
    const issues = formatZodIssues(parsed.error);
    throw validation(`Invalid request: ${issues.map((i) => `${i.field} ${i.message}`).join('; ')}`, issues);
  }
  const input = parsed.data;

  const garment = taxonomy.getGarment(input.garment);
  if (!garment) {
    throw validation(`Unknown garment "${input.garment}". Use one of: ${taxonomy.GARMENT_IDS.join(', ')}.`,
      [{ field: 'garment', code: 'UNKNOWN_GARMENT' }]);
  }

  const resolveArea = (value, field) => {
    const area = taxonomy.getDesignType(garment.id, value);
    if (!area) {
      throw validation(`"${value}" is not a design area of ${garment.id}. Use one of: ${taxonomy.designTypeIds(garment.id).join(', ')}.`,
        [{ field, code: 'UNKNOWN_DESIGN_AREA' }]);
    }
    return area;
  };

  const seenAreas = new Map();
  const designs = input.designs.map((d, i) => {
    const field = `designs[${i}]`;
    const area = resolveArea(d.area, `${field}.area`);
    if (seenAreas.has(area.id)) {
      throw validation(`${field} and ${seenAreas.get(area.id)} are both for ${area.id}. Send one design per area.`,
        [{ field: `${field}.area`, code: 'DUPLICATE_DESIGN_AREA' }]);
    }
    seenAreas.set(area.id, field);
    return {
      index: i,
      areaId: area.id,
      areaName: area.name,
      note: d.note || null,
      groundColor: d.groundColor || null,
      groundColorHex: d.groundColorHex ? `#${d.groundColorHex.replace('#', '').toUpperCase()}` : null,
      keepMotifColors: d.keepMotifColors === undefined ? true : d.keepMotifColors,
      coverage: d.coverage || 'full',
      source: classifyImage(d.image, `${field}.image`)
    };
  });

  let mainFabric = null;
  const claimed = new Map();
  const fabrics = input.fabrics.map((f, i) => {
    const field = `fabrics[${i}]`;
    let appliesTo = null;
    if (f.appliesTo) {
      appliesTo = [...new Set(f.appliesTo.map((a, j) => resolveArea(a, `${field}.appliesTo[${j}]`).id))];
      for (const areaId of appliesTo) {
        if (claimed.has(areaId)) {
          throw validation(`${field} and ${claimed.get(areaId)} both apply to ${areaId}. Each area can have one fabric.`,
            [{ field: `${field}.appliesTo`, code: 'FABRIC_AREA_CONFLICT' }]);
        }
        claimed.set(areaId, field);
      }
    } else {
      if (mainFabric !== null) {
        throw validation(`${field} and fabrics[${mainFabric}] both have no appliesTo. Only one fabric can be the main fabric; say where the others go.`,
          [{ field: `${field}.appliesTo`, code: 'MULTIPLE_MAIN_FABRICS' }]);
      }
      mainFabric = i;
    }
    return {
      index: i,
      name: f.name || null,
      material: f.material || null,
      color: f.color || null,
      colorHex: f.colorHex ? `#${f.colorHex.replace('#', '').toUpperCase()}` : null,
      itemCode: f.itemCode || null,
      appliesTo,
      note: f.note || null,
      source: classifyImage(f.image, `${field}.image`)
    };
  });

  return {
    clientId: input.clientId,
    productName: input.productName || null,
    garmentId: garment.id,
    garmentName: garment.name,
    designs,
    fabrics,
    model: input.modelImage
      ? { kind: 'reference', source: classifyImage(input.modelImage, 'modelImage'), gender: input.modelGender || null }
      : { kind: 'generated', gender: input.modelGender || garmentGuide(garment.id).wearer },
    notes: input.notes || null,
    pairWith: input.pairWith && (input.pairWith.color || input.pairWith.colorHex || input.pairWith.note)
      ? {
        color: input.pairWith.color || null,
        colorHex: input.pairWith.colorHex ? `#${input.pairWith.colorHex.replace('#', '').toUpperCase()}` : null,
        note: input.pairWith.note || null
      }
      : null
  };
}

module.exports = { resolveRequest, canonicaliseFields, classifyImage, hostAllowed, MODEL_GENDERS, schema };
