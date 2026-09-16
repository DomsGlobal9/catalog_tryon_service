// =============================================================================
// describeReferences.js — step one: put the references into words.
// =============================================================================
//
// WHY THIS EXISTS, measured on real generations: giving the image model only
// pictures lost the things that make a design that design. A border full of
// temple (mandir) outlines came back as plain zari bands, small multi-coloured
// butis came back single-colour gold, and a dense brocade jaal flattened into
// plain silk.
//
// So a cheap text model looks at the same pictures first and writes a short,
// factual description of each one - motifs, how they repeat, colours, technique,
// weave. Those words go to the image model next to the picture, and words are
// much harder to quietly ignore than pixels.
//
// ONLY THE NAMED PART. A design reference is often a photo of a whole garment on
// a person. Measured: a SLEEVE reference that was a whole printed kurti was
// described with "neckline has tiny dots", and its neckline embroidery and body
// print then appeared on the new blouse. A blouse BACK reference worn with a
// saree was described by the saree's scattered motifs. So each design is
// described for its one named part and nothing else in the photograph.
//
// EVERY REFERENCE, OR SAY SO. One real run came back describing only the fabric.
// The answer's shape is now enforced with a response schema, ref numbers are
// read leniently, and any reference still missing is asked about once more on
// its own before giving up on it.
//
// NEVER REQUIRED. It has its own time limit, and any failure (timeout, quota,
// unparseable answer) simply means generation continues with the pictures alone.
//
const { config } = require('./config');
const { redact } = require('./errors');

let fetchImpl = (...args) => fetch(...args);

const FIELDS = ['motifs', 'layout', 'colours', 'technique', 'notes'];
// Whether a design part's background is its own contrast colour or just the cloth
// of the garment it was photographed on. Read by the prompt to decide its colour.
const GROUND_FIELDS = ['groundType', 'groundColour'];
const GROUND_TYPES = ['contrast panel', 'garment fabric', 'not applicable'];

const INSTRUCTIONS = [
  'You are a textile technologist writing a tech-pack from photographs.',
  'Each reference below is labelled. A DESIGN reference is the design for ONE named part of ONE garment (for example the SLEEVE of a blouse).',
  'If the photograph shows a whole garment, a whole outfit or a person: describe ONLY the named part as it appears in the photograph. Do not describe any other part of that garment (its neckline, body, print, border, hem or sleeves when they are not the named part), any other garment in the photograph (a saree, dupatta, skirt or trousers worn with it), or the person, their hair, hair flowers, jewellery or makeup.',
  'If the photograph is NOT a garment - a close-up, a flat swatch, a strip of trim, a piece of artwork, a pattern or any other picture - then the whole picture IS the design chosen for that part: describe the motifs, layout and colours it shows. Never answer that the photograph does not show the part.',
  'A FABRIC reference is a piece of cloth: describe the cloth itself.',
  'Describe every reference you are given, one entry each, using its reference number.',
  '',
  'Fields for each reference:',
  '- motifs:    what the motifs actually ARE, named plainly (temple/mandir spires, peacock feathers with eyes, paisley, lotus, jaal trellis, chevron...). Say how many across a band or a metre when you can. Empty if the part is plain.',
  '- layout:    where they sit on that part and how they repeat (continuous band, scattered buttis every ~6cm, scalloped hem, vertical chains...).',
  '- colours:   the motif colours and the background colour separately, in plain words.',
  '- technique: woven zari / brocade jaal / thread embroidery / sequins / mirror work / block print / digital print, and the sheen.',
  '- notes:     anything a tailor copying this part must not miss, including trims, drops or plain areas at an edge. 25 words maximum.',
  '- groundType: for a DESIGN only. "contrast panel" ONLY when the named part is a yoke, panel, patch, band or appliqué whose background is a clearly DIFFERENT colour from the rest of the garment in the photograph (for example a red embroidered yoke on a blue kurta). "garment fabric" when the part\'s background is the same colour as the rest of the garment - even if it is a separately cut or stitched panel (for example an ivory gota yoke on an ivory kurta, or embroidery on a kurti that is mustard all over) - and for lace, net, sheer trims and close-ups where the rest of the garment cannot be seen. "not applicable" for a FABRIC.',
  '- groundColour: the background colour of that contrast panel in plain words (for example "deep red"); empty otherwise.',
  'Keep every field under 40 words.'
].join('\n');

// Enforced by the API, so the answer cannot come back in another shape.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    references: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          ref: { type: 'INTEGER' },
          motifs: { type: 'STRING' },
          layout: { type: 'STRING' },
          colours: { type: 'STRING' },
          technique: { type: 'STRING' },
          notes: { type: 'STRING' },
          groundType: { type: 'STRING', enum: GROUND_TYPES },
          groundColour: { type: 'STRING' }
        },
        required: ['ref', ...FIELDS, ...GROUND_FIELDS],
        propertyOrdering: ['ref', ...FIELDS, ...GROUND_FIELDS]
      }
    }
  },
  required: ['references']
};

/** Strip code fences and pull the first JSON object out of a text answer. */
function parseJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 3, "3", "Reference 3", "Image 3" -> 3. Anything else -> null. */
function refNumber(value) {
  if (Number.isInteger(value)) return value;
  const match = typeof value === 'string' && value.match(/\d+/);
  return match ? Number(match[0]) : null;
}

/** What each reference is, in the words the describe model reads. */
function labelFor(item) {
  if (item.kind === 'design') {
    return `Reference ${item.ref} - DESIGN for ${item.part || item.label}. Describe ONLY ${item.part ? `the ${item.part}` : 'that part'} in this photograph:`;
  }
  return `Reference ${item.ref} - FABRIC${item.label ? ` (${item.label})` : ''}. Describe the cloth itself:`;
}

/**
 * Turn a parsed answer into ref -> description, for the refs that were asked about.
 * Entries without a usable ref number are matched by position only when the
 * answer has exactly one entry per reference, in order.
 */
function readAnswer(parsed, items) {
  const out = new Map();
  const list = parsed && Array.isArray(parsed.references) ? parsed.references : [];
  const wanted = new Set(items.map((i) => i.ref));
  const byPosition = list.length === items.length;
  list.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') return;
    let ref = refNumber(entry.ref);
    if (!wanted.has(ref) && byPosition) ref = items[i].ref;
    if (!wanted.has(ref) || out.has(ref)) return;
    const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 400) : '');
    const described = Object.fromEntries([...FIELDS, ...GROUND_FIELDS].map((f) => [f, clean(entry[f])]));
    // Measured: "The photograph does not depict a saree border" with every other
    // field empty. Notes alone are not a description - count it as missing.
    if (described.motifs || described.layout || described.colours || described.technique) out.set(ref, described);
  });
  return out;
}

/** One call to the describe model for these items. Never throws. */
async function ask(items, signal) {
  const parts = [{ text: INSTRUCTIONS }];
  for (const item of items) {
    parts.push({ text: labelFor(item) });
    parts.push({ inlineData: { mimeType: item.image.mimeType, data: item.image.base64 } });
  }
  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: config.describe.maxOutputTokens
  };
  if (/2\.5/.test(config.describe.model)) {
    generationConfig.thinkingConfig = { thinkingBudget: config.describe.thinkingBudget };
  }
  const url = `${config.gemini.baseUrl}/models/${encodeURIComponent(config.describe.model)}:generateContent`;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey() },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
      signal
    });
    if (!response.ok) {
      return { map: new Map(), problem: `HTTP ${response.status} ${redact(await response.text().catch(() => '')).slice(0, 120)}` };
    }
    const json = await response.json();
    const candidate = (json.candidates || [])[0];
    const text = ((candidate && candidate.content && candidate.content.parts) || [])
      .filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
    const parsed = parseJson(text);
    const finish = candidate && candidate.finishReason;
    if (!parsed) return { map: new Map(), problem: `answer was not usable JSON (finish ${finish || 'unknown'}, ${text.length} chars)` };
    const map = readAnswer(parsed, items);
    return { map, problem: map.size < items.length ? `answer covered ${map.size} of ${items.length} (finish ${finish || 'unknown'}): ${redact(text).slice(0, 160)}` : null };
  } catch (err) {
    return { map: new Map(), problem: redact(err && err.message), aborted: signal && signal.aborted };
  }
}

/**
 * @param {Object[]} items  [{ ref, kind: 'design'|'fabric'|'model', label, part, image }]
 * @param {Object} options  { signal }
 * @returns {Promise<Map<number, Object>>} ref number -> description (empty on any failure)
 */
async function describeReferences(items, { signal } = {}) {
  const out = new Map();
  // A model photo is a person, not a design: nothing in it may be described.
  const wanted = items.filter((i) => i.kind === 'design' || i.kind === 'fabric');
  if (!config.describe.enabled || !wanted.length || !config.gemini.apiKey()) return out;

  const timeout = AbortSignal.timeout(config.describe.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const first = await ask(wanted, combined);
  for (const [ref, info] of first.map) out.set(ref, info);
  if (signal && signal.aborted) return out;

  let second = null;
  if (wanted.some((i) => !out.has(i.ref)) && !combined.aborted) {
    // One more try for just the missing ones, inside the same time limit.
    second = await ask(wanted.filter((i) => !out.has(i.ref)), combined);
    for (const [ref, info] of second.map) out.set(ref, info);
  }
  const missing = wanted.filter((i) => !out.has(i.ref));
  if (missing.length && !(signal && signal.aborted)) {
    console.warn(`[DesignStudio] describe step: ${out.size} of ${wanted.length} references described; missing ${missing.map((i) => i.ref).join(', ')}. `
      + `First: ${first.problem || 'ok'}. Retry: ${second ? second.problem || 'ok' : 'no time left'}.`);
  }
  return out;
}

module.exports = { describeReferences, parseJson, readAnswer, labelFor, _setFetch: (fn) => { fetchImpl = fn; } };
