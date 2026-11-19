// =============================================================================
// parts/request.js — POST /parts: the request as a job, or a 400. Nothing is downloaded here.
// =============================================================================
//
// { clientId, garment, photos: [image | { image, view }], parts?: [area | { area, note }], enhance? }
//
// Spellings a caller is likely to send are accepted: photo / image / imageUrl for a single photo,
// images for several, backPhoto for the back, areas for parts, part / type / name inside a part.

const { z } = require('zod');
const { config } = require('../config');
const { validation } = require('../errors');
const { taxonomy, garmentGuide } = require('../garmentGuide');
const { classifyImage, formatZodIssues, imageField, text } = require('../validate');

const VIEWS = ['front', 'back', 'side', 'detail'];

const photoItem = z.union([
  imageField,
  z.object({ image: imageField, view: z.enum(VIEWS, { error: `must be one of ${VIEWS.join(', ')}` }).optional() }).strict()
]);
const partItem = z.union([
  z.string().trim().min(1).max(40),
  z.object({ area: z.string().trim().min(1).max(40), note: text(config.limits.maxNoteChars).optional() }).strict()
]);

const schema = z.object({
  clientId: z.string().trim().min(1).max(128),
  garment: z.string().trim().min(1).max(40),
  productName: text(120).optional(),
  photos: z.array(photoItem).min(1, 'at least one photo is required').max(config.parts.maxPhotos, `at most ${config.parts.maxPhotos} photos`),
  parts: z.array(partItem).min(1, 'name at least one part, or leave parts out for all of them').max(config.parts.maxParts, `at most ${config.parts.maxParts} parts`).optional(),
  // false: the part as cut from the photo, without the image model (fast, nothing redrawn).
  enhance: z.boolean().optional()
}).strict();

const pick = (obj, from, to) => {
  if (obj[from] !== undefined && obj[to] === undefined) obj[to] = obj[from];
  if (from !== to) delete obj[from];
};

function canonicalise(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const body = { ...raw };
  for (const k of ['client_id']) pick(body, k, 'clientId');
  for (const k of ['productType', 'garmentType', 'garment_key', 'garment_type']) pick(body, k, 'garment');
  for (const k of ['product_name']) pick(body, k, 'productName');
  for (const k of ['images', 'photo_urls', 'photoUrls']) pick(body, k, 'photos');
  for (const k of ['areas', 'part_names']) pick(body, k, 'parts');
  // One photo under a single-photo name.
  for (const k of ['photo', 'image', 'imageUrl', 'image_url', 'photoUrl', 'photo_url']) {
    if (body[k] !== undefined) {
      if (body.photos === undefined) body.photos = [body[k]];
      delete body[k];
    }
  }
  // The back, sent on its own.
  for (const k of ['backPhoto', 'back_photo', 'backImage', 'back_image']) {
    if (body[k] !== undefined) {
      body.photos = [...(Array.isArray(body.photos) ? body.photos : body.photos !== undefined ? [body.photos] : []), { image: body[k], view: 'back' }];
      delete body[k];
    }
  }
  if (Array.isArray(body.photos)) {
    body.photos = body.photos.map((p) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
      const photo = { ...p };
      for (const k of ['imageUrl', 'image_url', 'url', 'photo']) pick(photo, k, 'image');
      if (typeof photo.view === 'string') photo.view = photo.view.trim().toLowerCase();
      return photo;
    });
  }
  if (Array.isArray(body.parts)) {
    body.parts = body.parts.map((p) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
      const part = { ...p };
      for (const k of ['part', 'type', 'name', 'id']) pick(part, k, 'area');
      pick(part, 'description', 'note');
      return part;
    });
  }
  return body;
}

/** A part name as the garment's design area: exact, then as words, then each word from the last. */
function resolveArea(garmentId, value, field) {
  const words = String(value).toLowerCase().split(/[\s_/&+,-]+/).filter(Boolean);
  const area = taxonomy.getDesignType(garmentId, value)
    || taxonomy.getDesignType(garmentId, words.join(' '))
    || [...words].reverse().map((w) => taxonomy.getDesignType(garmentId, w)).find(Boolean);
  if (!area) {
    throw validation(`"${value}" is not a part of ${garmentId}. Use one of: ${taxonomy.designTypeIds(garmentId).join(', ')}.`,
      [{ field, code: 'UNKNOWN_DESIGN_AREA' }]);
  }
  return area;
}

/** @returns {Object} the job; @throws StudioError 400 */
function resolvePartsRequest(rawBody) {
  const parsed = schema.safeParse(canonicalise(rawBody === undefined ? {} : rawBody));
  if (!parsed.success) {
    const issues = formatZodIssues(parsed.error);
    throw validation(`Invalid request: ${issues.map((i) => `${i.field} ${i.message}`).join('; ')}`, issues);
  }
  const input = parsed.data;
  const garment = taxonomy.getGarment(input.garment);
  if (!garment) {
    throw validation(`Unknown garment "${input.garment}". Use one of: ${taxonomy.GARMENT_IDS.join(', ')}.`, [{ field: 'garment', code: 'UNKNOWN_GARMENT' }]);
  }

  const warnings = [];
  let wanted;
  if (input.parts) {
    wanted = input.parts.map((p, i) => (typeof p === 'string' ? { value: p, note: null, field: `parts[${i}]` } : { value: p.area, note: p.note || null, field: `parts[${i}].area` }));
  } else {
    // Every part of the garment except the whole garment itself.
    const all = taxonomy.designTypeIds(garment.id).filter((id) => id !== 'OVERALL');
    if (all.length > config.parts.maxParts) warnings.push(`A ${garment.name} has ${all.length} parts; the first ${config.parts.maxParts} were made. Name the parts you want in parts.`);
    wanted = all.slice(0, config.parts.maxParts).map((id) => ({ value: id, note: null, field: 'parts' }));
  }
  const parts = [];
  for (const w of wanted) {
    const area = resolveArea(garment.id, w.value, w.field);
    if (parts.some((p) => p.areaId === area.id)) continue; // named twice: made once
    parts.push({ areaId: area.id, name: area.name, note: w.note });
  }

  const photos = input.photos.map((p, i) => {
    const image = typeof p === 'string' ? p : p.image;
    const field = typeof p === 'string' ? `photos[${i}]` : `photos[${i}].image`;
    return { index: i, field, view: (typeof p === 'object' && p.view) || null, source: classifyImage(image, field) };
  });

  return {
    endpoint: 'parts',
    clientId: input.clientId,
    garmentId: garment.id,
    garmentName: garment.name,
    product: garmentGuide(garment.id).product,
    productName: input.productName || null,
    photos,
    parts,
    enhance: input.enhance !== false,
    inputWarnings: warnings,
    // What the shared image loader and capacity code expect of a job.
    designs: [],
    fabrics: [],
    model: { kind: 'none' }
  };
}

module.exports = { resolvePartsRequest, VIEWS };
