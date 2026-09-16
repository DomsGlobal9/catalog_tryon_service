// =============================================================================
// cropReferences.js — show the image model only the part it is meant to copy.
// =============================================================================
//
// WHY THIS EXISTS. A design reference is often a photo of a whole outfit: a NECK
// design that is a kurta sequinned all over, a SLEEVE design on a navy blouse.
// Rules ("take ONLY its neckline") and the inspector's corrections argue with the
// picture afterwards, and measured in production they lost: the sequins covered
// the whole new kurta, printed sleeves came across from a neck photo, a navy cuff
// stayed navy. The model cannot copy what it is not shown.
//
// One small vision call per design picture finds the named part (run alongside
// the describe step, so it adds no waiting), and the picture is cropped to it with
// a margin, so the part keeps its shape and how it sits on the body.
//
// NEVER REQUIRED. No box, a box that is already most of the picture, a box that
// makes no sense, or a crop that would be too small: the picture is used whole,
// exactly as before.
//
const sharp = require('sharp');
const { config } = require('./config');
const { GLOBAL_AREAS, describeArea, garmentGuide } = require('./garmentGuide');

let fetchImpl = (...args) => fetch(...args);

const LOCATE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    view: { type: 'STRING', enum: ['part in a larger picture', 'close-up of the part', 'not visible'] },
    box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } }
  },
  required: ['view', 'box_2d'],
  propertyOrdering: ['view', 'box_2d']
};

/** The areas a crop can help: a named part of a garment, not the whole design. */
const croppable = (areaId) => !GLOBAL_AREAS.has(areaId) && areaId !== 'OVERALL';

/**
 * Find the named part in one design picture. Never throws unless the caller cancelled.
 * @returns {Promise<number[]|null>} [ymin, xmin, ymax, xmax] on 0-1000, or null to use the picture whole
 */
async function locatePart(garmentId, design, { signal } = {}) {
  const product = garmentGuide(garmentId).product;
  const part = design.areaId.toLowerCase().replace(/_/g, ' ');
  const where = describeArea(garmentId, design.areaId).split(/\.\s/)[0];
  const text = [
    `This picture was sent as the design for the ${part} of a ${product} (${where}).`,
    `Find that ${part} in the picture. It may be shown on a different kind of garment than a ${product} (a border on a dupatta, a sleeve on a kurti): find the same part there.`,
    'view: "close-up of the part" when the picture is already just that part, a swatch, a strip of trim or artwork; "not visible" when the part cannot be seen, or the picture shows many different garments side by side, or is not clothing; otherwise "part in a larger picture".',
    `box_2d: for "part in a larger picture", the box around the whole ${part} as [ymin, xmin, ymax, xmax], each 0-1000 relative to the picture - the whole part, not just its edge or its trim. Otherwise an empty list.`
  ].join('\n');
  const timeout = AbortSignal.timeout(config.crop.timeoutMs);
  try {
    const response = await fetchImpl(`${config.gemini.baseUrl}/models/${encodeURIComponent(config.crop.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey() },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: design.image.mimeType, data: design.image.base64 } }, { text }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: LOCATE_SCHEMA,
          maxOutputTokens: 1024,
          ...(/2\.5/.test(config.crop.model) ? { thinkingConfig: { thinkingBudget: 0 } } : {})
        }
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!response.ok) return null;
    const json = await response.json();
    const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
    const parsed = JSON.parse(parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('').replace(/```(?:json)?/gi, '').trim());
    return parsed && parsed.view === 'part in a larger picture' && readBox(parsed.box_2d) ? parsed.box_2d.map(Number) : null;
  } catch (err) {
    if (signal && signal.aborted) throw err;
    return null;
  }
}

/** Boxes for every croppable design, found in parallel. ref -> box. */
async function locateParts(job, { signal } = {}) {
  const boxes = new Map();
  if (!config.crop.enabled || !config.gemini.apiKey()) return boxes;
  await Promise.all(job.designs.map(async (d, i) => {
    if (!croppable(d.areaId) || !d.image || !d.image.base64) return;
    const box = await locatePart(job.garmentId, d, { signal });
    if (box) boxes.set(i + 1, box);
  }));
  return boxes;
}

/** [ymin, xmin, ymax, xmax] on 0-1000 -> a checked box, or null. */
function readBox(box) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => Number.isFinite(Number(v)))) return null;
  const [y0, x0, y1, x1] = box.map((v) => Math.min(1000, Math.max(0, Number(v))));
  if (y1 - y0 < 30 || x1 - x0 < 30) return null; // 3% of a side: a mistake, not a part
  return { y0, x0, y1, x1 };
}

/**
 * The pixel rectangle to keep, or null to use the whole picture.
 * @param {{y0,x0,y1,x1}} box  0-1000
 * @param {number} width
 * @param {number} height
 */
function cropRect(box, width, height, { tight = false } = {}) {
  const c = tight ? { ...config.crop, margin: config.crop.tightMargin, minShare: config.crop.tightMinShare } : config.crop;
  const fraction = ((box.y1 - box.y0) / 1000) * ((box.x1 - box.x0) / 1000);
  if (fraction >= c.skipIfBoxCovers) return null; // already a close-up
  // A margin on every side, relative to the box, so a neckline keeps its shoulders.
  const bw = ((box.x1 - box.x0) / 1000) * width;
  const bh = ((box.y1 - box.y0) / 1000) * height;
  const mx = Math.max(bw * c.margin, width * 0.03);
  const my = Math.max(bh * c.margin, height * 0.03);
  // Measured: a SLEEVE box around the cuff alone, a NECK box around the neckline
  // alone. A crop keeps at least this share of each side, centred on the part, so
  // the sleeve keeps its puff and the neckline its shoulders.
  const span = (lo, hi, size) => {
    let a = lo, b = hi;
    const want = size * c.minShare;
    if (b - a < want) { const mid = (a + b) / 2; a = mid - want / 2; b = mid + want / 2; }
    if (a < 0) { b -= a; a = 0; }
    if (b > size) { a -= b - size; b = size; }
    return [Math.max(0, Math.floor(a)), Math.min(size, Math.ceil(b))];
  };
  const [left, right] = span((box.x0 / 1000) * width - mx, (box.x1 / 1000) * width + mx, width);
  const [top, bottom] = span((box.y0 / 1000) * height - my, (box.y1 / 1000) * height + my, height);
  const w = right - left;
  const h = bottom - top;
  if ((w * h) / (width * height) >= c.skipIfBoxCovers) return null;
  return { left, top, width: w, height: h };
}

/**
 * Crop each design image of the job to its located part, in place.
 * @param {Object} job
 * @param {Map<number, number[]>} boxes  ref -> [ymin, xmin, ymax, xmax] from locateParts
 * @returns {Promise<{ area: string, ref: number, from: string, to: string }[]>} what was cropped
 */
async function cropReferences(job, boxes, { tight = false } = {}) {
  const done = [];
  if (!config.crop.enabled || !boxes || !boxes.size) return done;
  let ref = 0;
  for (const d of job.designs) {
    ref += 1;
    if (!croppable(d.areaId)) continue; // the whole picture IS the design
    const box = readBox(boxes.get(ref));
    // Always cut from the picture as sent, so a tighter crop is not a crop of a crop.
    const source = d.sourceImage || d.image;
    if (!box || !source || !source.base64) continue;
    try {
      const input = Buffer.from(source.base64, 'base64');
      const meta = await sharp(input).metadata();
      const rect = cropRect(box, meta.width, meta.height, { tight });
      if (!rect) continue;
      // A small crop is enlarged so the image model reads its motifs at a useful size.
      const short = Math.min(rect.width, rect.height);
      const long = Math.max(rect.width, rect.height);
      const scale = Math.min(short < config.crop.minSidePx ? config.crop.minSidePx / short : 1, Math.max(1, config.crop.maxSidePx / long));
      let pipeline = sharp(input).extract(rect);
      if (scale > 1) pipeline = pipeline.resize(Math.round(rect.width * scale), Math.round(rect.height * scale), { kernel: 'lanczos3' });
      const output = await pipeline.jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
      d.sourceImage = source;
      d.image = { ...source, mimeType: 'image/jpeg', base64: output.data.toString('base64'), cropped: { width: output.info.width, height: output.info.height } };
      done.push({ area: d.areaId, ref, from: `${meta.width}x${meta.height}`, to: `${output.info.width}x${output.info.height}` });
    } catch {
      // A crop is an improvement, never a requirement.
    }
  }
  return done;
}

module.exports = { locateParts, cropReferences, cropRect, readBox, LOCATE_SCHEMA, _setFetch: (fn) => { fetchImpl = fn; } };
