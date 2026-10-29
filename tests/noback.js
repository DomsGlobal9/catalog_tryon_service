// No back view (29 Oct). Runs the REAL generate4ViewCatalog -- base models fetched, garment prepared,
// prompts built, views streamed -- with only the image model replaced: GEMINI_BASE_URL points at a
// stand-in on this machine that answers every call with a small JPEG and keeps what it was asked.
//
// Checks a catalog is front, side and sitting, in that order of arrival for the front; that the
// image model is asked exactly three times; that no call carries the BACK prompt; and that a caller
// still sending a back base model (an older caller) gets no back view either.
//
// The base model pictures are fetched from public addresses (needs internet, costs nothing).
// SAFETY: no Gemini key is used and no real image model is called.   node tests/noback.js
const http = require('http');
const path = require('path');
const sharp = require('sharp');

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail === undefined ? '' : ' -- ' + JSON.stringify(detail).slice(0, 300)}`); }
};

// Public pictures to stand in for the model's poses; any photograph will do.
const PUBLIC = 'https://izrzvdejtfhpzrxzkasu.supabase.co/storage/v1/object/public/inventory-images/shop-banners/';
const BASES = {
  front: `${PUBLIC}666c4dc9a5e7736159659c20ff5dcd7e.jpg`,
  side: `${PUBLIC}d486b264b52c12767333f0bd28f0b406.jpg`,
  sitting: `${PUBLIC}666c4dc9a5e7736159659c20ff5dcd7e.jpg`,
  back: `${PUBLIC}d486b264b52c12767333f0bd28f0b406.jpg`
};

(async () => {
  const asked = [];
  const reply = (await sharp({ create: { width: 300, height: 400, channels: 3, background: '#7a1f2b' } }).jpeg().toBuffer()).toString('base64');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parts = JSON.parse(body).contents[0].parts;
      asked.push(parts.filter((p) => p.text).map((p) => p.text).join('\n'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: reply } }] } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.GEMINI_API_KEY = 'stand-in-not-a-key';

  const ai = require(path.join(__dirname, '..', 'src/services/catalogAiService'));
  const sys = require(path.join(__dirname, '..', 'src/config/sys-constants-catalog'));
  const { ENVIRONMENTS, VARIANT_ENVIRONMENT } = require(path.join(__dirname, '..', 'src/config/environments-catalog'));
  const garment = `data:image/jpeg;base64,${(await sharp({ create: { width: 600, height: 800, channels: 3, background: '#c9a227' } }).jpeg().toBuffer()).toString('base64')}`;

  // Every BACK prompt the builder could have made, whatever studio was picked.
  const dependent = { hasFullDress: false, hasTop: false, hasBottom: false, hasReference: true };
  const envs = [...(Array.isArray(ENVIRONMENTS) ? ENVIRONMENTS : Object.values(ENVIRONMENTS || {})), VARIANT_ENVIRONMENT].filter(Boolean);
  const backPrompts = new Set(envs.map((e) => sys.getDynamicPrompt('BACK', 'SAREE', dependent, e)));

  const run = async (label, bases, colour = null) => {
    asked.length = 0;
    const streamed = [];
    console.log(`\n${label}`);
    let out;
    try {
      out = await ai.generate4ViewCatalog(
        { fullDress: garment, category: 'SAREE', colour },
        bases,
        (e) => { if (e.view) streamed.push(e.view); }
      );
    } catch (e) {
      // Each case reports on its own, so one that stops cannot hide what the others show.
      check(`the catalog was made (stopped at: ${String((e && e.message) || e).split('\n')[0]})`, false);
      return;
    }
    check('streams front first, then side and sitting -- and no back', streamed[0] === 'front' && JSON.stringify([...streamed].sort()) === JSON.stringify(['front', 'side', 'sitting']), streamed);
    check('returns front, side and sitting, nothing called back', JSON.stringify(Object.keys(out).sort()) === JSON.stringify(['front', 'side', 'sitting']) && Object.values(out).every((v) => /^data:image\/jpeg;base64,/.test(v)), Object.keys(out));
    const calls = colour && ai.COLOUR_VARIANT_MODE === 'pass' ? 4 : 3;
    check(`the image model is asked ${calls} times (one per view${calls === 4 ? ', plus the recolour pass' : ''})`, asked.length === calls, asked.length);
    check('no call carries the BACK prompt', backPrompts.size > 0 && asked.every((t) => ![...backPrompts].some((b) => t.includes(b))));
  };

  try {
    await run('A catalog, from a caller sending front, side and sitting', { front: BASES.front, side: BASES.side, sitting: BASES.sitting });
    await run('An older caller still sending a back pose: ignored', BASES);
    await run('A colour variant', { front: BASES.front, side: BASES.side, sitting: BASES.sitting }, { name: 'Royal Blue', hex: '#2745a8' });
  } catch (e) {
    check(`the run reached the end (stopped at: ${String(e && e.message || e).split('\n')[0]})`, false);
  } finally {
    server.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
