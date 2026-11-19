// =============================================================================
// parts/cut.js — cut a part out of the photo, at the photo's full size.
// =============================================================================
//
// The box from locate.js says where the part is; this decides how much is kept. Each side gets a
// small margin and is grown to at least parts.minShare of the photo's short side, centred on the
// part, so a cuff keeps its sleeve and a neckline its shoulders (measured 19 Nov: the model's
// tight boxes alone gave 48 px sleeves on a 1024 px photo).

const sharp = require('sharp');
const { config } = require('../config');

// The shapes the image model can make, as width / height.
const RATIOS = [['21:9', 21 / 9], ['16:9', 16 / 9], ['3:2', 3 / 2], ['4:3', 4 / 3], ['5:4', 5 / 4], ['1:1', 1],
  ['4:5', 4 / 5], ['3:4', 3 / 4], ['2:3', 2 / 3], ['9:16', 9 / 16]];
const nearestRatio = (r) => RATIOS.reduce((b, x) => (Math.abs(Math.log(x[1] / r)) < Math.abs(Math.log(b[1] / r)) ? x : b))[0];

// What is sent to the image model: enough to read the work, never a giant request.
const MAX_CUT_EDGE = 2048;
const MAX_ELONGATION = 2;
// A sleeve or hand is shown whole, shoulder to end: a full-length sleeve is about four times as long as wide.
const WHOLE_ELONGATION = 4;
// ...and is cut tight to itself: only this much room is added around a thin sleeve.
const WHOLE_MIN_SHARE = 0.08;
const PAD = { r: 128, g: 128, b: 128 };

/**
 * The pixel rectangle to keep.
 * @param {{y0,x0,y1,x1}} box  0-1000
 */
function cutRect(box, width, height, { margin = config.parts.margin, minShare = config.parts.minShare, maxElongation = MAX_ELONGATION } = {}) {
  const bw = ((box.x1 - box.x0) / 1000) * width;
  const bh = ((box.y1 - box.y0) / 1000) * height;
  const minSide = Math.min(width, height) * minShare;
  const span = (lo, hi, size) => {
    let a = lo, b = hi;
    if (b - a < minSide) { const mid = (a + b) / 2; a = mid - minSide / 2; b = mid + minSide / 2; }
    if (a < 0) { b -= a; a = 0; }
    if (b > size) { a -= b - size; b = size; }
    return [Math.max(0, Math.floor(a)), Math.min(size, Math.ceil(b))];
  };
  let [left, right] = span((box.x0 / 1000) * width - bw * margin, (box.x1 / 1000) * width + bw * margin, width);
  let [top, bottom] = span((box.y0 / 1000) * height - bh * margin, (box.y1 / 1000) * height + bh * margin, height);
  // Never longer than MAX_ELONGATION times the short side: measured 19 Nov, a pallu box ran from the
  // shoulder to the knee and its "close-up" was the whole woman. A section from the middle is kept.
  // Centred on the part itself, kept inside the photo.
  const trim = (partMid, keep, size) => {
    const mid = Math.min(size - keep / 2, Math.max(keep / 2, partMid));
    return [Math.round(mid - keep / 2), Math.round(mid + keep / 2)];
  };
  const w = right - left;
  const h = bottom - top;
  if (h > w * maxElongation) [top, bottom] = trim(((box.y0 + box.y1) / 2000) * height, w * maxElongation, height);
  if (w > h * maxElongation) [left, right] = trim(((box.x0 + box.x1) / 2000) * width, h * maxElongation, width);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/**
 * @param {{ base64: string }} image  the photo as kept
 * @returns {Promise<{ image: {mimeType, base64, width, height, bytes}, rect: Object, aspectRatio: string, lowDetail: boolean }>}
 */
async function cutPart(image, box, { whole = false } = {}) {
  const input = Buffer.from(image.base64, 'base64');
  const meta = await sharp(input).metadata();
  // A sleeve or hand is cut tight to itself (owner, 19 Nov 2026: "crop only the sleeve") - grown to
  // 30% of the photo, a narrow sleeve took in the bodice beside it.
  const rect = cutRect(box, meta.width, meta.height, whole
    ? { maxElongation: WHOLE_ELONGATION, minShare: WHOLE_MIN_SHARE }
    : { maxElongation: MAX_ELONGATION });
  let pipeline = sharp(input).extract(rect);
  if (Math.max(rect.width, rect.height) > MAX_CUT_EDGE) pipeline = pipeline.resize({ width: MAX_CUT_EDGE, height: MAX_CUT_EDGE, fit: 'inside' });
  let { data, info } = await pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
  let aspectRatio = nearestRatio(rect.width / rect.height);
  let padded = false;
  // Narrower or wider than any shape the image model can make: flat grey bands bring it to the
  // nearest one, and the model fills them with plain background (enhance.js) - so the frame never
  // has to be filled with more of the body or the blouse.
  const ratio = info.width / info.height;
  const [minName, minRatio] = RATIOS[RATIOS.length - 1];
  const [maxName, maxRatio] = RATIOS[0];
  if (whole && (ratio < minRatio * 0.97 || ratio > maxRatio * 1.03)) {
    const narrow = ratio < minRatio;
    const w = narrow ? Math.round(info.height * minRatio) : info.width;
    const h = narrow ? info.height : Math.round(info.width / maxRatio);
    const left = Math.floor((w - info.width) / 2);
    const top = Math.floor((h - info.height) / 2);
    ({ data, info } = await sharp(data)
      .extend({ left, right: w - info.width - left, top, bottom: h - info.height - top, background: PAD })
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true }));
    aspectRatio = narrow ? minName : maxName;
    padded = true;
  }
  return {
    image: { mimeType: 'image/jpeg', base64: data.toString('base64'), width: info.width, height: info.height, bytes: data.length },
    rect,
    aspectRatio,
    padded,
    // Little detail to work from: the close-up may have to fill in fine work. The boutique is told.
    lowDetail: Math.min(rect.width, rect.height) < config.parts.lowDetailPx
  };
}

module.exports = { cutPart, cutRect, nearestRatio, RATIOS };
