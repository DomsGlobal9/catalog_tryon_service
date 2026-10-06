// =============================================================================
// colourVariant.js — "the same saree, in another colour"
// =============================================================================
//
// The women's catalog reproduces the garment in the colour of the picture it
// is given. A product is usually sold in several colours, so a caller may ask
// for the catalog in a different one:
//
//   "color": "Bottle Green"                          a plain name
//   "color": "#0F5132"                               a hex code
//   "color": { "name": "Bottle Green", "hex": "#0F5132", "border": false, "blouse": false }
//
// This module turns any of those into one clean object the prompt and the
// response can use. The hex is turned into words too, because "deep bottle
// green" steers an image model far better than "#0F5132" ever will. The hex
// is still sent as a reference.
//
// Honest limit, stated in every response: the model gets CLOSE to the colour.
// It cannot hit an exact hex value. colorAccuracy is always "approximate".
//
const { NAMED, distance } = require('./designstudio/colours');

const MAX_NAME = 60;

class InvalidColour extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidColour';
    this.code = 'INVALID_COLOR';
    this.status = 400;
  }
}

const rgbOf = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i + 1, i + 3), 16));

/** "#0f5132", "0F5132" or "#0f5" -> "#0F5132". null when it is not a hex code. */
function normaliseHex(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(s)) return null;
  const six = s.length === 3 ? s.split('').map((ch) => ch + ch).join('') : s;
  return '#' + six.toUpperCase();
}

/** The closest colour word we know for a hex code: "#0F5132" -> "bottle green". */
function nearestName(hex) {
  const target = rgbOf(hex);
  let best = null;
  let bestDistance = Infinity;
  for (const [name, value] of Object.entries(NAMED)) {
    const d = distance(target, rgbOf('#' + value));
    if (d < bestDistance) { bestDistance = d; best = name; }
  }
  return best;
}

/** Plain words for how light and how strong a hex colour is: "deep, rich". */
function toneWords(hex) {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min));
  const words = [];
  if (l < 0.18) words.push('very deep');
  else if (l < 0.38) words.push('deep');
  else if (l > 0.82) words.push('very pale');
  else if (l > 0.66) words.push('light');
  if (s < 0.18 && l > 0.12 && l < 0.9) words.push('muted');
  else if (s > 0.72 && l > 0.25 && l < 0.75) words.push('vivid');
  else if (s > 0.45 && l >= 0.18 && l < 0.5) words.push('rich');
  return words.join(', ');
}

const titleCase = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());

const toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const SHADES = { dark: 0.6, deep: 0.6, light: 1.4, pale: 1.6 };

/**
 * A reference hex for a colour NAME, when the name is one we know: "magenta",
 * "dark magenta" (a shade of a known colour) or "blue violet" (two known colours
 * mixed). Without it a name-only request gave the model words alone, and two
 * neighbouring names ("blue violet", "dark magenta") came back alike.
 * null when the name is not one we can place - the words alone are sent then.
 */
function hexForName(name) {
  const key = name.toLowerCase().replace(/[\s-]+/g, ' ').trim();
  const known = (k) => NAMED[k] || NAMED[k.replace(/ /g, '-')];
  if (known(key)) return '#' + known(key);
  const [first, ...rest] = key.split(' ');
  const tail = rest.join(' ');
  if (SHADES[first] && known(tail)) {
    const f = SHADES[first];
    return toHex(rgbOf('#' + known(tail)).map((v) => (f < 1 ? v * f : v + (255 - v) * (f - 1) / f)));
  }
  if (rest.length === 1 && known(first) && known(tail)) {
    const a = rgbOf('#' + known(first));
    const b = rgbOf('#' + known(tail));
    return toHex(a.map((v, i) => (v + b[i]) / 2));
  }
  return null;
}

/**
 * Turns the caller's `color` into { name, hex, description, border, blouse }.
 * Returns null when nothing was asked for. Throws InvalidColour (HTTP 400)
 * when it cannot be understood, saying exactly what to fix.
 */
function parseColourVariant(raw) {
  if (raw === undefined || raw === null || raw === '') return null;

  let name = null;
  let hex = null;
  let border = false;
  let blouse = false;

  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    hex = normaliseHex(s);
    if (!hex) {
      if (/^#|^[0-9a-f]{6}$/i.test(s)) throw new InvalidColour(`color "${s}" is not a valid hex code. Use #RRGGBB, for example "#0F5132".`);
      name = s;
    }
  } else if (typeof raw === 'object' && !Array.isArray(raw)) {
    // Extra fields beside a name or hex are ignored, as they always were. An
    // object with NEITHER but with other fields ({ "value": "Dark Magenta" }) was
    // silently read as "no colour asked"; it is a mistake worth saying so.
    const unknown = Object.keys(raw).filter((k) => !['name', 'hex', 'border', 'blouse'].includes(k));
    const hasColour = ['name', 'hex'].some((k) => raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== '');
    if (unknown.length && !hasColour) {
      throw new InvalidColour(`color has unknown field${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}. Use { "name", "hex", "border", "blouse" }.`);
    }
    if (raw.hex !== undefined && raw.hex !== null && raw.hex !== '') {
      hex = normaliseHex(String(raw.hex));
      if (!hex) throw new InvalidColour(`color.hex "${raw.hex}" is not a valid hex code. Use #RRGGBB, for example "#0F5132".`);
    }
    if (raw.name !== undefined && raw.name !== null && String(raw.name).trim() !== '') {
      if (typeof raw.name !== 'string') throw new InvalidColour('color.name must be text, for example "Bottle Green".');
      name = raw.name.trim();
    }
    border = raw.border === true || raw.border === 'true';
    blouse = raw.blouse === true || raw.blouse === 'true';
  } else {
    throw new InvalidColour('color must be a colour name ("Bottle Green"), a hex code ("#0F5132"), or an object { "name", "hex", "border", "blouse" }.');
  }

  if (!name && !hex) {
    // An empty object is "nothing asked", like an absent field. Flags alone are a mistake.
    if (!border && !blouse) return null;
    throw new InvalidColour('color needs a name or a hex code: { "name": "Bottle Green", "hex": "#0F5132" }.');
  }

  const requested = hex || (name && titleCase(name));
  if (name) {
    name = name.replace(/\s+/g, ' ');
    if (name.length > MAX_NAME) throw new InvalidColour(`color.name is too long (${name.length} characters; the most is ${MAX_NAME}).`);
    if (!/^[a-z][a-z' -]*$/i.test(name)) throw new InvalidColour('color.name may contain only letters, spaces, hyphens and apostrophes, for example "Bottle Green" or "Off-White".');
    if (!hex) hex = hexForName(name);
  } else {
    name = nearestName(hex);
  }

  const tone = hex ? toneWords(hex) : '';
  const description = [tone, name.toLowerCase()].filter(Boolean).join(' ');

  return { name: titleCase(name), hex, description, border, blouse, requested };
}

/** The public shape sent back to the caller, honest about accuracy. */
function colourSummary(colour) {
  if (!colour) return null;
  return {
    requestedColor: colour.requested || colour.hex || colour.name,
    colorName: colour.name,
    colorHex: colour.hex,
    colorAccuracy: 'approximate',
    recolourBorder: colour.border,
    recolourBlouse: colour.blouse
  };
}

module.exports = { parseColourVariant, colourSummary, normaliseHex, nearestName, toneWords, hexForName, InvalidColour };
