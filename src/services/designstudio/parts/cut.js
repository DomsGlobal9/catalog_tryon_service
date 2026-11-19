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

/**
 * The pixel rectangle to keep.
 * @param {{y0,x0,y1,x1}} box  0-1000
 */
function cutRect(box, width, height, { margin = config.parts.margin, minShare = config.parts.minShare } = {}) {
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
  if (h > w * MAX_ELONGATION) [top, bottom] = trim(((box.y0 + box.y1) / 2000) * height, w * MAX_ELONGATION, height);
  if (w > h * MAX_ELONGATION) [left, right] = trim(((box.x0 + box.x1) / 2000) * width, h * MAX_ELONGATION, width);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/**
 * @param {{ base64: string }} image  the photo as kept
 * @returns {Promise<{ image: {mimeType, base64, width, height, bytes}, rect: Object, aspectRatio: string, lowDetail: boolean }>}
 */
async function cutPart(image, box) {
  const input = Buffer.from(image.base64, 'base64');
  const meta = await sharp(input).metadata();
  const rect = cutRect(box, meta.width, meta.height);
  let pipeline = sharp(input).extract(rect);
  if (Math.max(rect.width, rect.height) > MAX_CUT_EDGE) pipeline = pipeline.resize({ width: MAX_CUT_EDGE, height: MAX_CUT_EDGE, fit: 'inside' });
  const { data, info } = await pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
  return {
    image: { mimeType: 'image/jpeg', base64: data.toString('base64'), width: info.width, height: info.height, bytes: data.length },
    rect,
    aspectRatio: nearestRatio(rect.width / rect.height),
    // Little detail to work from: the close-up may have to fill in fine work. The boutique is told.
    lowDetail: Math.min(rect.width, rect.height) < config.parts.lowDetailPx
  };
}

module.exports = { cutPart, cutRect, nearestRatio, RATIOS };
