// Product shots (26 Nov 2026). Runs the REAL generate4ViewCatalog with the real product-shot module
// hooked in, with only Gemini replaced: both the image model and the checker point at a stand-in on
// this machine that answers with a small JPEG (images) or a verdict (checks) and keeps what it was asked.
//
// Checks: 3 views + 2 shots (folded, table; the pleats fan was dropped 26 Nov), shots start after the front and carry the saree, blouse and front
// references; no shot prompt asks for a person; a check that finds a difference makes one redo; a
// shot that fails is reported on its own and the views still arrive; settings vary; the route
// refuses productShots for a non-saree and with a colour variant before any work.
//
// The base model pictures are fetched from public addresses (needs internet, costs nothing).
// SAFETY: no Gemini key is used and no real AI model is called.   node tests/productshots.js
const http = require('http');
const path = require('path');
const sharp = require('sharp');

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail === undefined ? '' : ' -- ' + JSON.stringify(detail).slice(0, 300)}`); }
};

const PUBLIC = 'https://gsriztjnocjwgqkaxhhz.supabase.co/storage/v1/object/public/tryon-fits/';
const BASES = {
  front: `${PUBLIC}lehanga_duppatta1.jpg`,
  side: `${PUBLIC}lehangaduppatta2.jpg`,
  sitting: `${PUBLIC}lehanga_duppatta1.jpg`
};
const FOLDED = 'neatly folded into a flat rectangle';

(async () => {
  const images = [];   // prompt text of every image call
  const checks = [];   // every checker call
  let verdictFor = () => ({ same_design: true, same_colours: true, same_border: true, nothing_added: true, no_person: true, evidence: 'none' });
  let failImageWhen = () => false;
  const reply = (await sharp({ create: { width: 300, height: 400, channels: 3, background: '#7a1f2b' } }).jpeg().toBuffer()).toString('base64');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const parts = parsed.contents[0].parts;
      const text = parts.filter((p) => p.text).map((p) => p.text).join('\n');
      res.setHeader('content-type', 'application/json');
      if (parsed.generationConfig && parsed.generationConfig.responseSchema) {
        checks.push(text);
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdictFor(checks.length)) }] } }] }));
        return;
      }
      images.push({ text, refs: parts.filter((p) => p.text && /^[A-Z ]+ - /.test(p.text)).map((p) => p.text.split(' - ')[0]) });
      if (failImageWhen(text)) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'stand-in refusal' } })); return; }
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: reply } }] } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.GEMINI_BASE_URL = base;
  process.env.DESIGNSTUDIO_GEMINI_BASE_URL = `${base}/v1beta`;
  process.env.GEMINI_API_KEY = 'stand-in-not-a-key';
  process.env.DESIGNSTUDIO_CHECK_RETRY_MS = '5';

  const SRC = path.join(__dirname, '..', 'src');
  const ai = require(path.join(SRC, 'services/catalogAiService'));
  const shots = require(path.join(SRC, 'services/productShots'));
  const { SHOTS, pickPlace } = require(path.join(SRC, 'services/productShots/settings'));
  const jpeg = async (colour) => `data:image/jpeg;base64,${(await sharp({ create: { width: 600, height: 800, channels: 3, background: colour } }).jpeg().toBuffer()).toString('base64')}`;
  const saree = await jpeg('#c9a227');
  const blouse = await jpeg('#1f5c7a');

  const run = async (label, { withBlouse = false } = {}) => {
    images.length = 0; checks.length = 0;
    const events = [];
    console.log(`\n${label}`);
    try {
      const out = await ai.generate4ViewCatalog(
        {
          fullDress: saree, topFront: withBlouse ? blouse : undefined, category: 'SAREE',
          afterFront: (front, refs) => {
            events.push('shots-started');
            return shots.makeProductShots({ ...refs, front }, { generate: ai.callGeminiImageGen, onShot: (s) => events.push(s) });
          }
        },
        BASES,
        (e) => { if (e.view) events.push(e.view); }
      );
      return { out, events };
    } catch (e) {
      check(`the catalog was made (stopped at: ${String((e && e.message) || e).split('\n')[0]})`, false);
      return { out: null, events };
    }
  };

  try {
    // 1. The plain run.
    let { out, events } = await run('A saree catalog with productShots');
    const shotEvents = events.filter((e) => typeof e === 'object');
    check('the front arrives first, then the shots start', events[0] === 'front' && events[1] === 'shots-started', events.map((e) => (typeof e === 'object' ? e.shot : e)));
    check('side and sitting still arrive', events.includes('side') && events.includes('sitting'));
    check('two shots: folded and table, each with a picture', JSON.stringify(shotEvents.map((s) => s.shot).sort()) === JSON.stringify(['folded', 'table']) && shotEvents.every((s) => /^data:image\/jpeg;base64,/.test(s.image)), shotEvents.map((s) => s.shot));
    check('the result carries the two shots in order', out && Array.isArray(out.extra) && out.extra.map((s) => s.shot).join() === 'folded,table');
    check('the image model is asked 5 times (3 views + 2 shots)', images.length === 5, images.length);
    const shotCalls = images.filter((c) => c.text.includes('product photographer'));
    check('every shot call gets the SAREE and the FRONT VIEW, no BLOUSE when none was sent', shotCalls.length === 2 && shotCalls.every((c) => c.refs.join() === 'SAREE,FRONT VIEW'), shotCalls.map((c) => c.refs));
    check('every shot prompt forbids a person and keeps the saree exactly', shotCalls.every((c) => /NO person/.test(c.text) && /EXACTLY THE SAME SAREE/.test(c.text)));
    check('each shot names a setting from its own list', shotEvents.every((s) => SHOTS.find((x) => x.id === s.shot).places.includes(s.setting)));
    check('each shot was checked once and passed', checks.length === 2 && shotEvents.every((s) => s.checkPassed === true && s.regenerated === false), checks.length);

    // 2. With a blouse photo.
    ({ events } = await run('With a blouse photo', { withBlouse: true }));
    const withBlouse = images.filter((c) => c.text.includes('product photographer'));
    check('the shots get the BLOUSE too and are told to lay it beside the saree', withBlouse.length === 2 && withBlouse.every((c) => c.refs.join() === 'SAREE,BLOUSE,FRONT VIEW' && /blouse piece/.test(c.text)), withBlouse.map((c) => c.refs));

    // 3. The checker finds a difference on the first look at each shot: one redo each, kept when better.
    verdictFor = (n) => (n <= 2
      ? { same_design: false, same_colours: true, same_border: true, nothing_added: true, no_person: true, evidence: 'the motifs are bigger' }
      : { same_design: true, same_colours: true, same_border: true, nothing_added: true, no_person: true, evidence: 'none' });
    ({ events } = await run('The check finds a difference'));
    const redone = events.filter((e) => typeof e === 'object');
    check('each shot is made again once (7 image calls)', images.length === 7, images.length);
    check('the redo names the difference', images.filter((c) => /THE LAST ATTEMPT WAS WRONG: the motifs are bigger/.test(c.text)).length === 2);
    check('the redone shots pass and say regenerated', redone.length === 2 && redone.every((s) => s.regenerated === true && s.checkPassed === true), redone.map((s) => [s.regenerated, s.checkPassed]));

    // 4. Still different after the redo: delivered, marked, with what differs.
    verdictFor = () => ({ same_design: true, same_colours: false, same_border: true, nothing_added: true, no_person: true, evidence: 'paler' });
    ({ events } = await run('Still different after the redo'));
    const differs = events.filter((e) => typeof e === 'object');
    check('delivered with checkPassed false and the difference named', differs.length === 2 && differs.every((s) => s.image && s.checkPassed === false && s.differences.join() === 'same_colours'), differs.map((s) => s.differences));

    // 5. One shot cannot be made: reported alone, the rest and the views unaffected.
    verdictFor = () => ({ same_design: true, same_colours: true, same_border: true, nothing_added: true, no_person: true, evidence: 'none' });
    failImageWhen = (text) => text.includes(FOLDED);
    ({ out, events } = await run('The folded shot is refused'));
    const mixed = events.filter((e) => typeof e === 'object');
    const folded = mixed.find((s) => s.shot === 'folded');
    check('the folded shot comes back as an error, retryable, no picture', folded && !folded.image && folded.error && folded.error.code === 'PRODUCT_SHOT_FAILED' && folded.error.retryable === true, folded);
    check('the table shot is still made', mixed.filter((s) => s.image).map((s) => s.shot).join() === 'table');
    check('the three views are still made', out && out.front && out.side && out.sitting);
    check('the error message says nothing technical', folded && !/HTTP|400|stand-in/i.test(folded.error.message), folded && folded.error.message);
    failImageWhen = () => false;

    // 6. Settings change from product to product.
    const pleats = SHOTS.find((s) => s.id === 'folded');
    const seen = new Set(Array.from({ length: 40 }, () => pickPlace(pleats)));
    check('settings vary between products (40 picks, more than 3 different)', seen.size > 3, seen.size);
    check('a pinned random picks the first and last setting', pickPlace(pleats, () => 0) === pleats.places[0] && pickPlace(pleats, () => 0.9999) === pleats.places[pleats.places.length - 1]);
    check('the pleats fan is gone (owner, 26 Nov)', !SHOTS.some((s) => s.id === 'pleats' || /hand fan/.test(s.scene)));

    // 7. The route refuses before any work.
    const router = require(path.join(SRC, 'routes/catalogRoutes'));
    const handler = router.stack.find((l) => l.route && l.route.path === '/generate-catalog/women').route.stack[0].handle;
    const routeRes = () => ({ statusCode: 200, body: null, headersSent: false, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {}, write() {}, end() {}, on() {} });
    const before = images.length;
    const lehenga = routeRes();
    await handler({ body: { clientId: 'c', modelId: 'lehanga1', saree: 'x', category: 'LEHANGA', productShots: true }, on() {} }, lehenga);
    check('a lehenga with productShots is a 400 PRODUCT_SHOTS_SAREE_ONLY', lehenga.statusCode === 400 && lehenga.body.code === 'PRODUCT_SHOTS_SAREE_ONLY', [lehenga.statusCode, lehenga.body]);
    const coloured = routeRes();
    await handler({ body: { clientId: 'c', modelId: 'saree1', saree: 'x', productShots: 'true', colour: 'Royal Blue' }, on() {} }, coloured);
    check('productShots with a colour variant is a 400', coloured.statusCode === 400 && coloured.body.code === 'PRODUCT_SHOTS_NO_COLOUR_VARIANT', [coloured.statusCode, coloured.body]);
    check('no AI was called for either', images.length === before);
  } catch (e) {
    check(`the run reached the end (stopped at: ${String(e && e.message || e).split('\n')[0]})`, false);
  } finally {
    server.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
