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
// NEVER REQUIRED. It has its own time limit, and any failure (timeout, quota,
// unparseable answer) simply means generation continues with the pictures alone.
//
const { config } = require('./config');
const { redact } = require('./errors');

let fetchImpl = (...args) => fetch(...args);

const SCHEMA_HINT = `Answer with JSON only, in exactly this shape:
{"references":[{"ref":1,"motifs":"","layout":"","colours":"","technique":"","notes":""}]}
- motifs:    what the motifs actually ARE, named plainly (temple/mandir spires, peacock feathers with eyes, paisley, lotus, jaal trellis, chevron...). Say how many across a band or a metre when you can.
- layout:    where they sit and how they repeat (continuous band, scattered buttis every ~6cm, scalloped hem, vertical chains...).
- colours:   the motif colours and the background colour separately, in plain words.
- technique: woven zari / brocade jaal / thread embroidery / sequins / mirror work / block print / digital print, and the sheen.
- notes:     anything a tailor copying this must not miss, including plain areas at an edge. 25 words maximum.
Keep every field under 40 words. No markdown, no commentary.`;

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

/**
 * @param {Object[]} items  [{ ref, kind: 'design'|'fabric', label, image }]
 * @param {Object} options  { signal }
 * @returns {Promise<Map<number, Object>>} ref number -> description (empty on any failure)
 */
async function describeReferences(items, { signal } = {}) {
  const out = new Map();
  if (!config.describe.enabled || !items.length || !config.gemini.apiKey()) return out;

  const parts = [{
    text: [
      'You are a textile technologist writing a tech-pack from photographs.',
      'Describe each reference image below exactly as it is. Describe only the cloth and its design: ignore any person, mannequin, background, watermark or text in the photograph.',
      '',
      SCHEMA_HINT
    ].join('\n')
  }];
  for (const item of items) {
    parts.push({ text: `Reference ${item.ref} (${item.kind}${item.label ? `, ${item.label}` : ''}):` });
    parts.push({ inlineData: { mimeType: item.image.mimeType, data: item.image.base64 } });
  }

  const url = `${config.gemini.baseUrl}/models/${encodeURIComponent(config.describe.model)}:generateContent`;
  const timeout = AbortSignal.timeout(config.describe.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey() },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: config.describe.maxOutputTokens }
      }),
      signal: combined
    });
    if (!response.ok) {
      console.warn(`[DesignStudio] describe step skipped: HTTP ${response.status} ${redact(await response.text().catch(() => '')).slice(0, 120)}`);
      return out;
    }
    const json = await response.json();
    const candidate = (json.candidates || [])[0];
    const text = ((candidate && candidate.content && candidate.content.parts) || [])
      .filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
    const parsed = parseJson(text);
    if (!parsed || !Array.isArray(parsed.references)) {
      console.warn('[DesignStudio] describe step skipped: answer was not usable JSON');
      return out;
    }
    for (const entry of parsed.references) {
      const ref = Number(entry && entry.ref);
      if (!Number.isInteger(ref)) continue;
      const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 400) : '');
      const described = {
        motifs: clean(entry.motifs),
        layout: clean(entry.layout),
        colours: clean(entry.colours),
        technique: clean(entry.technique),
        notes: clean(entry.notes)
      };
      if (Object.values(described).some(Boolean)) out.set(ref, described);
    }
    return out;
  } catch (err) {
    if (signal && signal.aborted) return out;
    console.warn(`[DesignStudio] describe step skipped: ${redact(err && err.message)}`);
    return out;
  }
}

module.exports = { describeReferences, parseJson, _setFetch: (fn) => { fetchImpl = fn; } };
