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

const REFINE_SCHEMA = {
  type: 'OBJECT',
  properties: { box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } } },
  required: ['box_2d']
};

/**
 * A sleeve or hand, looked at a second time on a cut around it (owner, 19 Nov 2026: "crop only the
 * sleeve"). On the whole photo the finder's box around a sleeve hanging beside the body took in
 * the bodice too; on a cut where the sleeve is large it is drawn tight. Never throws unless
 * cancelled: any failure keeps the first box.
 * @returns {Promise<{y0,x0,y1,x1}>} the box on the whole photo, 0-1000
 */
async function refineWholeBox(job, part, photo, box, { signal } = {}) {
  const { width: W, height: H } = photo.image.sent;
  // The first box with room on every side, so a sleeve the first box cut short is still inside.
  const grow = 0.25;
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  const area = {
    x0: Math.max(0, box.x0 - bw * grow), x1: Math.min(1000, box.x1 + bw * grow),
    y0: Math.max(0, box.y0 - bh * grow), y1: Math.min(1000, box.y1 + bh * grow)
  };
  const rect = {
    left: Math.floor((area.x0 / 1000) * W), top: Math.floor((area.y0 / 1000) * H),
    width: Math.max(1, Math.ceil(((area.x1 - area.x0) / 1000) * W)), height: Math.max(1, Math.ceil(((area.y1 - area.y0) / 1000) * H))
  };
  try {
    const cut = await sharp(Buffer.from(photo.image.base64, 'base64')).extract(rect)
      .resize({ width: config.parts.locateEdgePx, height: config.parts.locateEdgePx, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 }).toBuffer();
    const text = [
      `This picture is cut from a photo of a ${job.product}. Find its ${part.name.toLowerCase()}: ${partWhere(job.garmentId, part.areaId)}.`,
      'box_2d: [ymin, xmin, ymax, xmax], each 0-1000 relative to THIS picture, around the WHOLE sleeve - from the shoulder seam at the top all the way down to where the sleeve ends, the plain or printed fabric of the sleeve AND its border or cuff. Never only the border or cuff. Tight at the sides: the bodice, the body and anything beside the sleeve stay outside the box.'
    ].join('\n');
    const timeout = AbortSignal.timeout(config.parts.locateTimeoutMs);
    const response = await fetchImpl(`${config.gemini.baseUrl}/models/${encodeURIComponent(config.parts.locateModel)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey() },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: cut.toString('base64') } }, { text }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: REFINE_SCHEMA, maxOutputTokens: 512,
          ...(/2\.5/.test(config.parts.locateModel) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) }
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!response.ok) {
      aiLog({ call: 'tight-sleeve', model: config.parts.locateModel, result: 'skipped', reason: `HTTP ${response.status}`, why: 'the first, wider box is used' });
      return box;
    }
    const json = await response.json();
    const answer = ((((json.candidates || [])[0] || {}).content || {}).parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
    const inner = readBox((JSON.parse(answer.replace(/```(?:json)?/gi, '').trim()) || {}).box_2d);
    if (!inner) {
      aiLog({ call: 'tight-sleeve', model: config.parts.locateModel, result: 'skipped', reason: 'no usable box', why: 'the first, wider box is used' });
      return box;
    }
    // Back to the whole photo.
    const sx = (area.x1 - area.x0) / 1000;
    const sy = (area.y1 - area.y0) / 1000;
    const tight = { x0: area.x0 + inner.x0 * sx, x1: area.x0 + inner.x1 * sx, y0: area.y0 + inner.y0 * sy, y1: area.y0 + inner.y1 * sy };
    // Only the sides are taken from this look. Measured 19 Nov in production: asked again, the finder
    // boxed only the gold cuff - the most decorated piece - and the "hand" was the border again. The
    // length, shoulder to end, always stays the first look's (or longer, if this one saw more).
    const sides = { x0: Math.max(0, tight.x0 - (tight.x1 - tight.x0) * 0.06), x1: Math.min(1000, tight.x1 + (tight.x1 - tight.x0) * 0.06) };
    const overlaps = sides.x0 < box.x1 && sides.x1 > box.x0;
    if (!overlaps) {
      aiLog({ call: 'tight-sleeve', model: config.parts.locateModel, result: 'skipped', reason: 'its box missed the sleeve', why: 'the first, wider box is used' });
      return box;
    }
    return { x0: Math.max(sides.x0, 0), x1: sides.x1, y0: Math.min(box.y0, tight.y0), y1: Math.max(box.y1, tight.y1) };
  } catch (err) {
    if (signal && signal.aborted) throw err;
    aiLog({ call: 'tight-sleeve', model: config.parts.locateModel, result: 'skipped',
      reason: err && err.name === 'TimeoutError' ? 'no answer in time' : 'unreadable answer', why: 'the first, wider box is used' });
    return box;
  }
}

module.exports = { locateParts, locateInPhoto, refineWholeBox, readBox, promptFor, SCHEMA, _setFetch: (fn) => { fetchImpl = fn; } };
