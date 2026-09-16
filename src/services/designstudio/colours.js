// =============================================================================
// colours.js — are two colour descriptions the same colour, near enough?
// =============================================================================
//
// Used twice: the prompt only tells the image model to replace a reference's
// ground colour when it really differs from the new one, and the quality gate
// only checks for a leaked ground colour under the same condition.
//
// Measured false alarms without the name table: "off-white/cream" on an ivory
// #EDE3CC sherwani, "gold" zari on an antique gold #C9A227 pallu. Word stems
// alone cannot see that cream and ivory are the same colour.
//

// Approximate sRGB for the colour words the describe step actually uses.
const NAMED = {
  'off white': 'FAF7EE', 'off-white': 'FAF7EE', white: 'FFFFFF', ivory: 'F2EAD3', cream: 'FFF8DC', pearl: 'EAE0C8',
  beige: 'E8D9B5', champagne: 'F1DDB5', 'light beige': 'EFE3C8', sand: 'D8C29D', khaki: 'BDB07A', fawn: 'C8A97E',
  black: '111111', charcoal: '36454F', grey: '8C8C8C', gray: '8C8C8C', silver: 'C0C0C0',
  gold: 'D4AF37', golden: 'D4AF37', 'antique gold': 'C9A227', mustard: 'D4A017', yellow: 'F2D600', lemon: 'F5E663',
  orange: 'F28C28', peach: 'F6C6A8', coral: 'F88379', rust: 'B7410E', copper: 'B87333', bronze: 'CD7F32', brown: '7B4A2D', tan: 'D2B48C', chocolate: '5A3A22',
  red: 'C8102E', 'bright red': 'E3120B', crimson: 'B0122E', scarlet: 'D9281C', maroon: '7B1E2B', wine: '6D1A36', burgundy: '800020',
  pink: 'F4A6C1', 'hot pink': 'E8318A', rani: 'D6246E', magenta: 'C21E8C', fuchsia: 'D0209A', rose: 'E7849C', blush: 'EFC3C8',
  purple: '6A2C91', violet: '7F3FBF', lilac: 'B7A2D6', lavender: 'C8B6E2', mauve: 'B784A7', plum: '6E3060',
  blue: '2F5DB3', 'navy blue': '1C2B5A', navy: '1C2B5A', 'royal blue': '2745A8', indigo: '2E3A87', 'sky blue': '7FB9E6', 'light blue': 'A7CBEA', 'powder blue': 'B6D0E2', 'ink blue': '1F2F4F',
  teal: '11706B', turquoise: '2EC4B6', aqua: '5FD3D0', cyan: '3CC8E0',
  green: '2E8B57', 'bottle green': '1F4D2B', emerald: '0B6E4F', olive: '6B7A2A', mint: 'A8E6C1', 'sea green': '2E8B6E', 'parrot green': '5DBB3F', 'lime': 'B5D83B', sage: 'A3B18A'
};
const NAMES = Object.keys(NAMED).sort((a, b) => b.length - a.length);

const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Every colour a description names, as RGB: explicit hex first, then known words. */
function coloursIn(text) {
  const s = ` ${String(text || '').toLowerCase().replace(/[\/,;()]+/g, ' ')} `;
  const found = (s.match(/#[0-9a-f]{6}/g) || []).map((h) => rgb(h.slice(1)));
  let rest = s.replace(/#[0-9a-f]{6}/g, ' ');
  for (const name of NAMES) {
    const re = new RegExp(`[^a-z]${name.replace(/[-]/g, '[- ]')}[^a-z]`);
    if (re.test(rest)) {
      found.push(rgb(NAMED[name]));
      rest = rest.replace(re, ' ');
    }
  }
  return found;
}

/** Perceptually weighted RGB distance (0 .. ~765). */
function distance(a, b) {
  const rm = (a[0] + b[0]) / 2;
  const [dr, dg, db] = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

/**
 * "golden beige" vs "antique gold #C9A227" -> true; "off-white/cream" vs "ivory #EDE3CC" -> true;
 * "alternating navy blue and white" vs "lilac #B7A2D6" -> false.
 * Deliberately generous: a skipped check is safer than a false alarm.
 */
function sameColourFamily(a, b) {
  const stems = (s) => new Set(String(s).toLowerCase().replace(/#[0-9a-f]{6}/g, '').match(/[a-z]+/g) || []);
  const norm = (w) => w.replace(/(en|ish|y)$/, '');
  const ignore = new Set(['light', 'dark', 'deep', 'pale', 'bright', 'soft', 'rich', 'dull', 'muted', 'and', 'or', 'with', 'hex', 'the', 'a', 'shade', 'tone', 'sheer', 'solid', 'plain', 'alternating', 'fabric', 'colour', 'color', 'background', 'off']);
  const A = [...stems(a)].filter((w) => !ignore.has(w)).map(norm);
  const B = new Set([...stems(b)].filter((w) => !ignore.has(w)).map(norm));
  if (A.some((w) => B.has(w))) return true;
  const ca = coloursIn(a), cb = coloursIn(b);
  return ca.some((x) => cb.some((y) => distance(x, y) < 110));
}

module.exports = { sameColourFamily, coloursIn, distance };
