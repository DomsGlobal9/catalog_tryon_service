// =============================================================================
// parts/locate.js — where each part is in the boutique's photos.
// =============================================================================
//
// One small vision call per photo (all parts at once), in parallel. Each part is then taken from
// the photo that shows it best: "clearly" before "partly", then the larger. A part no photo shows
// is reported as not visible - never made up: the back of a blouse photographed from the front
// cannot be drawn faithfully, and a tailor would stitch from it.
//
// Measured 19 Nov 2026 on four real photos: asking for "the whole part" gave a box of nearly the
// whole saree for its border, pallu and zari; asking for a close-up frame gives the place where
// the part's design is clearest. How big the cut then is, is decided by cut.js, not the model.

const sharp = require('sharp');
const { config } = require('../config');
const { aiLog } = require('../../../lib/stepLog');
const { partWhere } = require('./describe');

let fetchImpl = (...args) => fetch(...args);

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    parts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          part: { type: 'STRING' },
          visible: { type: 'STRING', enum: ['clearly', 'partly', 'no'] },
          box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
          note: { type: 'STRING' }
        },
        required: ['part', 'visible', 'box_2d', 'note'],
        propertyOrdering: ['part', 'visible', 'box_2d', 'note']
      }
    }
  },
  required: ['parts']
};

function promptFor(job, photo) {
  const list = job.parts.map((p) => `- ${p.areaId}: ${partWhere(job.garmentId, p.areaId)}${p.note ? ` (${p.note})` : ''}`).join('\n');
  return [
    `This is a photo of a ${job.product}${photo.view ? `, showing its ${photo.view}` : ''}. For each part below, find it in the photo.`,
    list,
    'part: the id exactly as written above.',
    'visible: "clearly" when the part is in the photo and its design can be seen; "partly" when only some of it shows or it is hidden by hands, hair, jewellery or folds; "no" when it is not in the photo at all (for example the back of a garment photographed from the front). Never guess a part that is not there.',
    'box_2d: for a visible part, a CLOSE-UP frame as [ymin, xmin, ymax, xmax], each 0-1000 relative to the photo: the smallest area that shows the design of that part clearly, as a tailor would photograph it up close. A small part (neckline, cuff, waistband) whole, with a little of what is around it. A sleeve or hand whole, from the shoulder seam to where it ends, and tight to the sleeve itself - not the bodice, the body or anything beside it. A long or large part (border, pallu, body, skirt, hemline, zari or embroidery work) only a section of it: where its design is clearest and least hidden by folds, hands or jewellery, showing one or two repeats of the pattern - never the whole garment. Keep faces out of the box wherever the part allows. For "no": an empty list.',
    'note: a few words on what the part looks like, or why it is not visible.'
  ].join('\n');
}

/** [ymin, xmin, ymax, xmax] on 0-1000 -> a checked box, or null. */
function readBox(box) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => Number.isFinite(Number(v)))) return null;
  const [y0, x0, y1, x1] = box.map((v) => Math.min(1000, Math.max(0, Number(v))));
  if (y1 <= y0 || x1 <= x0) return null;
  return { y0, x0, y1, x1 };
}

/**
 * Ask about one photo. Asked twice when the answer cannot be had; never throws unless cancelled.
 * @returns {Promise<{ answers: Map<string, {visible, box, note}> } | { problem: string }>}
 */
async function locateInPhoto(job, photo, { signal } = {}) {
  const preview = await sharp(Buffer.from(photo.image.base64, 'base64'))
    .resize({ width: config.parts.locateEdgePx, height: config.parts.locateEdgePx, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 }).toBuffer();
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: preview.toString('base64') } }, { text: promptFor(job, photo) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
      maxOutputTokens: 4096,
      ...(/2\.5/.test(config.parts.locateModel) ? { thinkingConfig: { thinkingBudget: 0 } } : {})
    }
  });
  let problem = 'no answer';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const timeout = AbortSignal.timeout(config.parts.locateTimeoutMs);
    try {
      const response = await fetchImpl(`${config.gemini.baseUrl}/models/${encodeURIComponent(config.parts.locateModel)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey() },
        body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
      if (!response.ok) {
        problem = `HTTP ${response.status}`;
        aiLog({ call: 'find-parts', model: config.parts.locateModel, photo: photo.index, attempt, of: 2, result: attempt < 2 ? 'retrying' : 'gave_up', reason: problem });
        continue;
      }
      const json = await response.json();
      const text = ((((json.candidates || [])[0] || {}).content || {}).parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
      const parsed = JSON.parse(text.replace(/```(?:json)?/gi, '').trim());
      const answers = new Map();
      for (const a of (parsed && parsed.parts) || []) {
        const id = String(a.part || '').trim().toUpperCase();
        if (!job.parts.some((p) => p.areaId === id) || answers.has(id)) continue;
        const box = a.visible === 'no' ? null : readBox(a.box_2d);
        answers.set(id, { visible: box ? a.visible : 'no', box, note: typeof a.note === 'string' ? a.note.slice(0, 300) : '' });
      }
      if (attempt > 1) aiLog({ call: 'find-parts', model: config.parts.locateModel, photo: photo.index, attempt, of: 2, result: 'ok_after_retry' });
      return { answers };
    } catch (err) {
      if (signal && signal.aborted) throw err;
      problem = err && err.name === 'TimeoutError' ? 'timed out' : 'unreadable answer';
      aiLog({ call: 'find-parts', model: config.parts.locateModel, photo: photo.index, attempt, of: 2, result: attempt < 2 ? 'retrying' : 'gave_up', reason: problem });
    }
  }
  return { problem };
}

/** The part's short side in the photo as kept (photo.image.sent: up to parts.maxEdgePx), in pixels. */
const shortSidePx = (box, photo) => {
  const { width, height } = photo.image.sent;
  return Math.min(((box.x1 - box.x0) / 1000) * width, ((box.y1 - box.y0) / 1000) * height);
};

/**
 * Every photo asked in parallel, then the best photo chosen per part.
 * @returns {Promise<{ found: Object[], unanswered: number }>} one entry per requested part:
 *   { areaId, name, status: 'found'|'not_visible'|'too_small', photo, box, px, visible, note }
 */
async function locateParts(job, { signal } = {}) {
  const results = await Promise.all(job.photos.map((photo) => locateInPhoto(job, photo, { signal })));
  const answered = results.filter((r) => r.answers);
  const found = job.parts.map((part) => {
    let best = null;
    let note = '';
    results.forEach((r, i) => {
      const a = r.answers && r.answers.get(part.areaId);
      if (!a) return;
      if (!note && a.note) note = a.note;
      if (!a.box) return;
      const photo = job.photos[i];
      const px = shortSidePx(a.box, photo);
      const rank = a.visible === 'clearly' ? 2 : 1;
      if (!best || rank > best.rank || (rank === best.rank && px > best.px)) best = { rank, px, photo, box: a.box, visible: a.visible, note: a.note };
    });
    if (!best) return { areaId: part.areaId, name: part.name, status: 'not_visible', note };
    if (best.px < config.parts.minPartPx) return { areaId: part.areaId, name: part.name, status: 'too_small', px: Math.round(best.px), photo: best.photo, note: best.note };
    return { areaId: part.areaId, name: part.name, status: 'found', photo: best.photo, box: best.box, px: Math.round(best.px), visible: best.visible, note: best.note };
  });
  return { found, answeredPhotos: answered.length, problems: results.filter((r) => r.problem).map((r) => r.problem) };
}

module.exports = { locateParts, locateInPhoto, readBox, promptFor, SCHEMA, _setFetch: (fn) => { fetchImpl = fn; } };
