// Product shots (26 Nov 2026). Runs the REAL generate4ViewCatalog with the real product-shot module
// hooked in, with only Gemini replaced: both the image model and the checker point at a stand-in on
// this machine that answers with a small JPEG (images) or a verdict (checks) and keeps what it was asked.
//
// Checks: 3 views + 3 shots (folded, table, fabric close-up; the pleats fan was dropped 26 Nov), shots start after the front and carry the saree, blouse and front
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
  let verdictFor = () => ({ same_design: true, same_colours: true, same_border: true, nothing_added: true, same_spacing: true, no_person: true, evidence: 'none' });
  let failImageWhen = () => false;
  const readerCalls = []; // every "read the saree" call
  const READ_PLAIN = { best_layout_photo: 1, main_shows_layout: true, blouse_photo_shows: 'no blouse photo', body_colour: 'deep pink', body_stripes: 'none', body_motifs: 'small silver buttis in rows', border: 'narrow silver lattice', pallu: 'not shown', must_keep: ['small silver buttis spread evenly'] };
  let readerFor = () => READ_PLAIN;
  let readerDelayMs = 0;
  const sameChecks = [];  // every "is this extra photo the same saree?" call
  let sameSareeFor = () => ({ same_saree: true, evidence: 'same saree' });
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
        if (parsed.generationConfig.responseSchema.properties.best_layout_photo) {
          readerCalls.push({ text, images: parts.filter((p) => p.inlineData).length });
          const answer = readerFor(readerCalls.length);
          const send = () => res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: typeof answer === 'string' ? answer : JSON.stringify(answer) }] } }] }));
          if (readerDelayMs) setTimeout(send, readerDelayMs); else send();
          return;
        }
        if (parsed.generationConfig.responseSchema.properties.same_saree) {
          sameChecks.push(text);
          res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(sameSareeFor(sameChecks.length)) }] } }] }));
          return;
        }
        checks.push(text);
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdictFor(checks.length)) }] } }] }));
        return;
      }
      images.push({ text, refs: parts.filter((p) => p.text && /^[A-Z0-9 ]+ (-|—) /.test(p.text)).map((p) => p.text.split(/ (?:-|—) /)[0]) });
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
    check('three shots: folded, table, close-up, each with a picture', JSON.stringify(shotEvents.map((s) => s.shot).sort()) === JSON.stringify(['closeup', 'folded', 'table']) && shotEvents.every((s) => /^data:image\/jpeg;base64,/.test(s.image)), shotEvents.map((s) => s.shot));
    check('the result carries the three shots in order', out && Array.isArray(out.extra) && out.extra.map((s) => s.shot).join() === 'folded,table,closeup');
    check('the image model is asked 6 times (3 views + 3 shots)', images.length === 6, images.length);
    const shotCalls = images.filter((c) => c.text.includes('product photographer'));
    check('every shot call gets the SAREE and the FRONT VIEW, no BLOUSE when none was sent', shotCalls.length === 3 && shotCalls.every((c) => c.refs.join() === 'SAREE,FRONT VIEW'), shotCalls.map((c) => c.refs));
    check('every shot prompt forbids a person and keeps the saree exactly', shotCalls.every((c) => /NO person/.test(c.text) && /EXACTLY THE SAME SAREE/.test(c.text)));
    check('every shot prompt keeps the motif spacing and count', shotCalls.every((c) => /MOTIF SPACING AND COUNT/.test(c.text) && /never more crowded/.test(c.text)));
    check('the check asks about spacing too', checks.every((t) => /same_spacing/.test(t)));
    check('each shot names a setting from its own list', shotEvents.every((s) => SHOTS.find((x) => x.id === s.shot).places.includes(s.setting)));
    check('each shot was checked once and passed', checks.length === 3 && shotEvents.every((s) => s.checkPassed === true && s.regenerated === false), checks.length);

    // 2. With a blouse photo.
    ({ events } = await run('With a blouse photo', { withBlouse: true }));
    const withBlouse = images.filter((c) => c.text.includes('product photographer'));
    const scenes = withBlouse.filter((c) => !/THE LIGHT:/.test(c.text));
    const close = withBlouse.filter((c) => /THE LIGHT:/.test(c.text));
    check('folded and table get the BLOUSE too and are told to lay it beside the saree', scenes.length === 2 && scenes.every((c) => c.refs.join() === 'SAREE,BLOUSE,FRONT VIEW' && /blouse piece/.test(c.text)), scenes.map((c) => c.refs));
    check('the close-up gets no blouse (the fabric fills the frame) and no setting, only a light', close.length === 1 && close[0].refs.join() === 'SAREE,FRONT VIEW' && !/blouse piece/.test(close[0].text) && !/THE SETTING/.test(close[0].text) && /no props/.test(close[0].text), close.map((c) => c.refs));

    // 3. The checker finds a difference on the first look at each shot: one redo each, kept when better.
    verdictFor = (n) => (n <= 3
      ? { same_design: false, same_colours: true, same_border: true, nothing_added: true, no_person: true, evidence: 'the motifs are bigger' }
      : { same_design: true, same_colours: true, same_border: true, nothing_added: true, no_person: true, evidence: 'none' });
    ({ events } = await run('The check finds a difference'));
    const redone = events.filter((e) => typeof e === 'object');
    check('each shot is made again once (9 image calls)', images.length === 9, images.length);
    check('the redo names the difference', images.filter((c) => c.text.includes('THE EARLIER ATTEMPTS WERE WRONG: (1) the motifs are bigger')).length === 3);
    check('the redone shots pass and say regenerated, after one redo (a pass stops the redos)', redone.length === 3 && redone.every((s) => s.regenerated === true && s.checkPassed === true && s.redos === 1), redone.map((s) => [s.regenerated, s.checkPassed, s.redos]));

    // 4. Still different after the redo: delivered, marked, with what differs.
    verdictFor = () => ({ same_design: true, same_colours: false, same_border: true, nothing_added: true, no_person: true, evidence: 'paler' });
    ({ events } = await run('Still different after the redo'));
    const differs = events.filter((e) => typeof e === 'object');
    check('a shot that keeps differing is made twice more (3 views + 3 x 3 = 12 image calls)', images.length === 12, images.length);
    check('the second redo is told both differences found so far', images.filter((c) => c.text.includes('(1) paler (2) paler')).length === 3);
    check('each says 2 redos', differs.every((s) => s.redos === 2), differs.map((s) => s.redos));
    check('delivered with checkPassed false and the difference named', differs.length === 3 && differs.every((s) => s.image && s.checkPassed === false && s.differences.join() === 'same_colours'), differs.map((s) => s.differences));

    // 4b. The redos come out worse: the first, better picture is kept.
    verdictFor = (n) => (n <= 3
      ? { same_design: true, same_colours: false, same_border: true, nothing_added: true, same_spacing: true, no_person: true, evidence: 'paler' }
      : { same_design: false, same_colours: false, same_border: true, nothing_added: true, same_spacing: true, no_person: true, evidence: 'worse' });
    ({ events } = await run('The redos are worse'));
    const kept = events.filter((e) => typeof e === 'object');
    check('the better first picture is kept (one difference, not two)', kept.length === 3 && kept.every((s) => s.differences.join() === 'same_colours' && s.redos === 2), kept.map((s) => s.differences));

    // 5. One shot cannot be made: reported alone, the rest and the views unaffected.
    verdictFor = () => ({ same_design: true, same_colours: true, same_border: true, nothing_added: true, no_person: true, evidence: 'none' });
    failImageWhen = (text) => text.includes(FOLDED);
    ({ out, events } = await run('The folded shot is refused'));
    const mixed = events.filter((e) => typeof e === 'object');
    const folded = mixed.find((s) => s.shot === 'folded');
    check('the folded shot comes back as an error, retryable, no picture', folded && !folded.image && folded.error && folded.error.code === 'PRODUCT_SHOT_FAILED' && folded.error.retryable === true, folded);
    check('table and close-up are still made', mixed.filter((s) => s.image).map((s) => s.shot).sort().join() === 'closeup,table');
    check('the three views are still made', out && out.front && out.side && out.sitting);
    check('the error message says nothing technical', folded && !/HTTP|400|stand-in/i.test(folded.error.message), folded && folded.error.message);
    failImageWhen = () => false;

    // 6. Settings change from product to product.
    const pleats = SHOTS.find((s) => s.id === 'folded');
    const seen = new Set(Array.from({ length: 40 }, () => pickPlace(pleats)));
    check('settings vary between products (40 picks, more than 3 different)', seen.size > 3, seen.size);
    check('a pinned random picks the first and last setting', pickPlace(pleats, () => 0) === pleats.places[0] && pickPlace(pleats, () => 0.9999) === pleats.places[pleats.places.length - 1]);
    check('the pleats fan is gone (owner, 26 Nov)', !SHOTS.some((s) => s.id === 'pleats' || /hand fan/.test(s.scene)));

    // 6b. Extra photos of the same saree reach the front view, every shot and every check.
    {
      images.length = 0; checks.length = 0; sameChecks.length = 0;
      const pallu = await jpeg('#a01f5c');
      const border = await jpeg('#d4af37');
      const prepared = await ai.prepareInputs({ saree, extras: [pallu, border] });
      check('prepareInputs gives the saree and both extras', !!prepared.saree && prepared.extras.length === 2 && prepared.blouse === null && prepared.front === null);
      const events = [];
      console.log('\nWith two extra saree photos');
      await ai.generate4ViewCatalog(
        { fullDress: saree, category: 'SAREE', prepared,
          afterFront: (front, refs) => shots.makeProductShots({ ...refs, front }, { generate: ai.callGeminiImageGen, onShot: (s) => events.push(s) }) },
        BASES, () => {});
      const front = images.find((c) => c.refs[0] === 'GARMENT REFERENCE' && c.refs.includes('SAREE DETAIL 1'));
      check('the front view gets SAREE DETAIL 1 and 2, told they are the same saree', !!front && front.refs.includes('SAREE DETAIL 2') && /not a second garment/.test(front.text), images.map((c) => c.refs));
      const viewCalls = images.filter((c) => !c.text.includes('product photographer'));
      check('without a colour variant the extras are copied exactly, colours too', /Copy these details exactly/.test(front.text) && !/NOT its colours/.test(front.text));
      images.length = 0;
      await ai.generate4ViewCatalog({ fullDress: saree, category: 'SAREE', prepared, colour: { name: 'Royal Blue', hex: '#2745A8' } }, BASES, () => {});
      const recoloured = images.find((c) => c.refs[0] === 'GARMENT REFERENCE');
      check('with a colour variant the extras give the design only, never their old colour', recoloured && (recoloured.text.match(/NOT its colours: the colours follow the colour instruction/g) || []).length === 2, recoloured && recoloured.text.slice(-600));
      images.length = 0; checks.length = 0; events.length = 0;
      await ai.generate4ViewCatalog({ fullDress: saree, category: 'SAREE', prepared,
        afterFront: (front2, refs) => shots.makeProductShots({ ...refs, front: front2 }, { generate: ai.callGeminiImageGen, onShot: (s) => events.push(s) }) }, BASES, () => {});
      check('side and sitting do not get the extras (they copy the front)', viewCalls.filter((c) => c.refs.includes('SAREE DETAIL 1')).length === 1, viewCalls.length);
      const shotCalls = images.filter((c) => c.text.includes('product photographer'));
      check('every shot gets SAREE, SAREE DETAIL 1, SAREE DETAIL 2 and the FRONT VIEW', shotCalls.length === 3 && shotCalls.every((c) => c.refs.join() === 'SAREE,SAREE DETAIL 1,SAREE DETAIL 2,FRONT VIEW'), shotCalls.map((c) => c.refs));
      check('every shot is told to copy the pallu and border from them, never guess', shotCalls.every((c) => /copy the pallu and border from them exactly, never guess/.test(c.text)));
      check('every check sees the extras as part of the saree', checks.length === 3 && checks.every((t) => t.includes('SAREE 2 -') && t.includes('SAREE 3 -')), checks.length);
      check('all three shots made', events.filter((s) => s.image).length === 3);

      // Same-saree check.
      const uri = ai.toDataUri;
      let mismatched = await shots.verifyExtras(uri(prepared.saree), prepared.extras.map(uri));
      check('two matching extras: nothing refused, one check per extra', mismatched.length === 0 && sameChecks.length === 2, [mismatched, sameChecks.length]);
      const differ = { same_saree: false, certain: true, evidence: 'a green saree with a gold border, not this pink one' };
      const same = { same_saree: true, certain: true, evidence: 'same' };
      const one = [uri(prepared.extras[1])];
      // Certain and confirmed by a second look: refused, named by its place.
      sameChecks.length = 0; sameSareeFor = () => differ;
      mismatched = await shots.verifyExtras(uri(prepared.saree), [uri(prepared.extras[0]), ...one]);
      check('a certain "different", confirmed by a second look, is refused and named', mismatched.length === 2 && mismatched[1].index === 2 && /green saree/.test(mismatched[1].evidence) && sameChecks.length === 4, [mismatched, sameChecks.length]);
      // The production false refusal: one look says different, the second does not -> used.
      sameChecks.length = 0; sameSareeFor = (n) => (n === 1 ? differ : same);
      mismatched = await shots.verifyExtras(uri(prepared.saree), one);
      check('one look says different, the second says same: the photo is used (the 26 Nov false refusal)', mismatched.length === 0 && sameChecks.length === 2, [mismatched, sameChecks.length]);
      // Different but not certain: used, no second look.
      sameChecks.length = 0; sameSareeFor = () => ({ ...differ, certain: false });
      mismatched = await shots.verifyExtras(uri(prepared.saree), one);
      check('"different" twice but never certain: the photo is used', mismatched.length === 0 && sameChecks.length === 2, [mismatched, sameChecks.length]);
      sameChecks.length = 0; sameSareeFor = (n) => (n === 1 ? { ...differ, certain: false } : differ);
      mismatched = await shots.verifyExtras(uri(prepared.saree), one);
      check('an unsure "different" then a certain one: refused (1 of 3 teal photos slipped through before)', mismatched.length === 1 && sameChecks.length === 2, [mismatched, sameChecks.length]);
      // Body cloth of another colour is decisive even when the checker's own verdict wavers.
      sameChecks.length = 0; sameSareeFor = () => ({ same_saree: true, certain: false, extra_shows: ['body', 'border'], same_body_colour: false, evidence: 'teal body against a pink body' });
      mismatched = await shots.verifyExtras(uri(prepared.saree), one);
      check('a body of a different colour is refused (twice seen) even if same_saree wavers', mismatched.length === 1 && /teal body/.test(mismatched[0].evidence) && sameChecks.length === 2, [mismatched, sameChecks.length]);
      // A contrast pallu: another colour, but no body cloth in the photo -> the same saree.
      sameChecks.length = 0; sameSareeFor = () => ({ same_saree: true, certain: true, extra_shows: ['pallu'], same_body_colour: false, evidence: 'a green pallu on a red saree' });
      mismatched = await shots.verifyExtras(uri(prepared.saree), one);
      check('a contrast-colour pallu (no body cloth shown) is used, not refused', mismatched.length === 0 && sameChecks.length === 1, [mismatched, sameChecks.length]);
      sameSareeFor = () => same;
      check('the same-saree question asks which parts show, compares the body colour, allows a contrast pallu', sameChecks.every((t) => /extra_shows/.test(t) && /same_body_colour/.test(t) && /contrast colour/.test(t) && /main_body_colour/.test(t)));
    }

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

    // 7b. New fields refused clearly before any work.
    const refused = async (body) => { const r = routeRes(); await handler({ body, on() {} }, r); return [r.statusCode, r.body && r.body.code, r.body && r.body.error]; };
    let got = await refused({ clientId: 'c', modelId: 'saree1', saree: 'x', sareeExtras: ['a', 'b', 'c', 'd'] });
    check('four extra photos is a 400 INVALID_SAREE_EXTRAS naming the limit', got[0] === 400 && got[1] === 'INVALID_SAREE_EXTRAS' && /1 to 3/.test(got[2]), got);
    got = await refused({ clientId: 'c', modelId: 'saree1', saree: 'x', sareeExtras: ['a', ''] });
    check('an empty extra photo is a 400 INVALID_SAREE_EXTRAS', got[0] === 400 && got[1] === 'INVALID_SAREE_EXTRAS', got);
    got = await refused({ clientId: 'c', modelId: 'saree1', saree: 'x', sareeExtras: [{ url: 'a' }] });
    check('an extra photo that is not text is a 400', got[0] === 400 && got[1] === 'INVALID_SAREE_EXTRAS', got);
    got = await refused({ clientId: 'c', modelId: 'lehanga1', saree: 'x', category: 'LEHANGA', sareeExtras: ['a'] });
    check('extras on a lehenga is a 400 SAREE_EXTRAS_SAREE_ONLY', got[0] === 400 && got[1] === 'SAREE_EXTRAS_SAREE_ONLY', got);
    // Blanks a form leaves behind mean "not sent": they reach the next check, never an extras/frontView error.
    got = await refused({ clientId: 'c', modelId: 'lehanga1', saree: 'x', category: 'LEHANGA', sareeExtras: [], frontView: '', productShots: true });
    check('blank sareeExtras ([]) and frontView ("") are ignored - the lehenga gets the productShots error, not an extras one', got[1] === 'PRODUCT_SHOTS_SAREE_ONLY', got);
    got = await refused({ clientId: 'c', modelId: 'lehanga1', saree: 'x', category: 'LEHANGA', sareeExtras: '  ', frontView: null, productShots: true });
    check('sareeExtras "  " is ignored too', got[1] === 'PRODUCT_SHOTS_SAREE_ONLY', got);
    got = await refused({ clientId: 'c', saree: 'x', productShotsOnly: true, frontView: 42, category: 'SAREE', color: 'Red' });
    check('a frontView that is a number is still refused... after the colour rule', got[1] === 'PRODUCT_SHOTS_NO_COLOUR_VARIANT', got);
    got = await refused({ clientId: 'c', saree: 'x', productShotsOnly: true, frontView: 42 });
    check('a frontView that is a number is a 400 INVALID_FRONT_VIEW', got[0] === 400 && got[1] === 'INVALID_FRONT_VIEW', got);
    got = await refused({ clientId: 'c', modelId: 'saree1', saree: 'x', frontView: 'x' });
    check('frontView without productShotsOnly is a 400 INVALID_FRONT_VIEW', got[0] === 400 && got[1] === 'INVALID_FRONT_VIEW', got);
    got = await refused({ clientId: 'c', saree: 'x', productShotsOnly: true, category: 'LEHANGA' });
    check('productShotsOnly on a lehenga is a 400 that names productShotsOnly', got[0] === 400 && got[1] === 'PRODUCT_SHOTS_SAREE_ONLY' && /^productShotsOnly/.test(got[2]), got);
    got = await refused({ clientId: 'c', saree: 'x', productShotsOnly: true, color: 'Red' });
    check('productShotsOnly with a colour is a 400', got[0] === 400 && got[1] === 'PRODUCT_SHOTS_NO_COLOUR_VARIANT', got);
    got = await refused({ saree: 'x', productShotsOnly: true });
    check('productShotsOnly still needs a clientId', got[0] === 400 && /clientId is required/.test(got[2]), got);
    got = await refused({ clientId: 'c', saree: 'x' });
    check('a normal catalog still needs a modelId (unchanged)', got[0] === 400 && got[2] === 'clientId and modelId are required.', got);
    check('no AI was called for any of them', images.length === before);

    // 7c. productShotsOnly through the real route: no model views, the shots, COMPLETE.
    const streamRes = () => {
      const r = { statusCode: 200, body: null, headersSent: false, writableEnded: false, writableFinished: false, destroyed: false, events: [], handlers: {},
        status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; }, set() { return this; }, setHeader() {},
        flushHeaders() { this.headersSent = true; }, on(e, fn) { this.handlers[e] = fn; },
        write(chunk) { String(chunk).split('\n').filter((l) => l.startsWith('data: ')).forEach((l) => this.events.push(JSON.parse(l.slice(6)))); return true; },
        end() { this.writableEnded = true; this.writableFinished = true; } };
      return r;
    };
    images.length = 0; checks.length = 0; sameChecks.length = 0;
    const only = streamRes();
    console.log('\nproductShotsOnly through the route');
    await handler({ body: { clientId: 'shots-only-test', saree, blouse, sareeExtras: [saree], frontView: saree, productShotsOnly: true }, account: 'test-acct', headers: {}, on() {} }, only);
    const types = only.events.map((e) => e.type);
    check('the stream has the shots and COMPLETE, and no VIEW_READY', types.filter((t) => t === 'PRODUCT_SHOT').length === 3 && types[types.length - 1] === 'COMPLETE' && !types.includes('VIEW_READY'), types);
    const done = only.events.find((e) => e.type === 'COMPLETE');
    check('COMPLETE says 3 made, 0 failed, with a job id', done && done.productShots.made === 3 && done.productShots.failed === 0 && /^[0-9a-f-]{36}$/.test(done.jobId), done);
    check('only the 3 shots were drawn (no model views)', images.length === 3 && images.every((c) => c.text.includes('product photographer')), images.length);
    check('the shots got the saree, the extra, the blouse (folded/table) and the sent front view', images.filter((c) => c.refs.join() === 'SAREE,SAREE DETAIL 1,BLOUSE,FRONT VIEW').length === 2 && images.filter((c) => c.refs.join() === 'SAREE,SAREE DETAIL 1,FRONT VIEW').length === 1, images.map((c) => c.refs));
    check('the extra was checked to be the same saree', sameChecks.length === 1);

    // 7c2. A bad photo among several is named.
    const bad = streamRes();
    await handler({ body: { clientId: 'shots-only-test-bad', saree, sareeExtras: [saree, 'bm90IGFuIGltYWdl'], productShotsOnly: true }, account: 'test-acct', headers: {}, on() {} }, bad);
    const badErr = bad.events.find((e) => e.type === 'ERROR');
    check('an unreadable extra is named: "Extra photo 2 (sareeExtras): a garment image could not be read"', badErr && badErr.code === 'INVALID_IMAGE' && badErr.error.startsWith('Extra photo 2 (sareeExtras): a garment image could not be read'), badErr);
    const badFront = streamRes();
    await handler({ body: { clientId: 'shots-only-test-bad2', saree, frontView: 'bm90IGFuIGltYWdl', productShotsOnly: true }, account: 'test-acct', headers: {}, on() {} }, badFront);
    const badFrontErr = badFront.events.find((e) => e.type === 'ERROR');
    check('an unreadable frontView is named', badFrontErr && badFrontErr.error.startsWith('The front view (frontView): '), badFrontErr);

    // 7e. The saree reader (27 Nov): best main photo, a "blouse" that is the saree, facts everywhere.
    {
      const STRIPED = { best_layout_photo: 3, main_shows_layout: false, blouse_photo_shows: 'this saree', body_colour: 'dark maroon', body_stripes: 'thin vertical gold stripes in pairs', body_motifs: 'round gold buttas between the stripes', border: 'wide plain red, no zari', pallu: 'not shown', must_keep: ['the thin vertical gold stripes run through every pleat'] };
      readerFor = () => STRIPED; readerCalls.length = 0; images.length = 0; checks.length = 0;
      const r = streamRes();
      console.log('\nThe reader: a close-up sent as main, a saree sent as the blouse');
      const pallu = await jpeg('#550011');
      await handler({ body: { clientId: 'reader-test', saree, blouse, sareeExtras: [pallu, blouse], productShotsOnly: true }, account: 'test-acct', headers: {}, on() {} }, r);
      const statuses = r.events.filter((e) => e.type === 'STATUS').map((e) => e.message);
      check('the reader is asked once, with every photo (main, 2 extras, blouse) as small copies', readerCalls.length === 1 && readerCalls[0].images === 4, readerCalls.map((c) => c.images));
      check('a close-up main is swapped for the photo that shows the layout, and the stream says so', statuses.some((m) => /Using extra photo 2 as the main saree photo/.test(m)), statuses);
      check('a "blouse" photo that is the saree becomes a saree photo, and the stream says so', statuses.some((m) => /blouse photo shows the saree itself/.test(m)), statuses);
      const shotCalls = images.filter((c) => c.text.includes('product photographer'));
      check('the shots get 3 saree detail photos (2 extras + the moved blouse) and no BLOUSE', shotCalls.length === 3 && shotCalls.every((c) => c.refs.join() === 'SAREE,SAREE DETAIL 1,SAREE DETAIL 2,SAREE DETAIL 3'), shotCalls.map((c) => c.refs));
      check('every shot carries the SAREE FACTS with the stripes and the plain border', shotCalls.every((c) => /SAREE FACTS/.test(c.text) && /thin vertical gold stripes in pairs\. They run through the WHOLE body/.test(c.text) && /wide plain red, no zari\. Nothing else is added/.test(c.text) && /MUST KEEP: the thin vertical gold stripes run through every pleat/.test(c.text)));
      check('every shot check is told the facts and checks the stripes', checks.length >= 3 && checks.slice(-3).every((t) => /Notes on the real saree/.test(t) && /same_stripes/.test(t)), checks.length);

      // The views get the facts too, and a colour variant keeps the design only.
      images.length = 0;
      const prep = await ai.prepareInputs({ saree });
      await ai.generate4ViewCatalog({ fullDress: saree, category: 'SAREE', prepared: prep, facts: 'SAREE FACTS (test): - Body stripes: thin gold stripes.' }, BASES, () => {});
      check('front, side and sitting each carry the facts', images.length === 3 && images.every((c) => c.text.includes('SAREE FACTS (test)')), images.length);
      const { factsText } = require(path.join(SRC, 'services/sareeReader'));
      const recoloured = factsText(STRIPED, { colour: { name: 'Royal Blue' } });
      check('with a colour variant the facts name the new colour and drop the old one', /becomes Royal Blue/.test(recoloured) && !/dark maroon/.test(recoloured) && /thin vertical gold stripes/.test(recoloured), recoloured);
      const plain = factsText({ ...READ_PLAIN, body_stripes: 'none', body_motifs: 'none' });
      check('a saree without stripes or motifs is told "none - do not add any"', /Body stripes: none - do not add any/.test(plain) && /Body motifs: none - do not add any/.test(plain), plain);

      // Unusable answer: asked once more; then the job goes on as sent, no facts, no STATUS.
      readerFor = () => 'not json at all'; readerCalls.length = 0; images.length = 0;
      const bad = streamRes();
      await handler({ body: { clientId: 'reader-test-2', saree, productShotsOnly: true }, account: 'test-acct', headers: {}, on() {} }, bad);
      check('an unusable read is asked once more, then the shots are made without facts', readerCalls.length === 2 && bad.events.filter((e) => e.type === 'PRODUCT_SHOT' && e.image).length === 3 && images.every((c) => !/SAREE FACTS/.test(c.text)), [readerCalls.length, images.length]);
      check('nothing is swapped when the read failed', !bad.events.some((e) => e.type === 'STATUS' && /Using extra photo|blouse photo shows/.test(e.message)));

      // Too slow: past the budget the job goes on without the read.
      readerFor = () => STRIPED; readerDelayMs = 400; readerCalls.length = 0; images.length = 0;
      process.env.SAREE_LOOK_BUDGET_MS = '100';
      delete require.cache[require.resolve(path.join(SRC, 'routes/catalogRoutes'))];
      const slowHandler = require(path.join(SRC, 'routes/catalogRoutes')).stack.find((l) => l.route && l.route.path === '/generate-catalog/women').route.stack[0].handle;
      const slow = streamRes();
      const t0 = Date.now();
      await slowHandler({ body: { clientId: 'reader-test-3', saree, blouse, productShotsOnly: true }, account: 'test-acct', headers: {}, on() {} }, slow);
      check('a read slower than its budget is skipped: shots made, no facts, blouse kept', slow.events.filter((e) => e.type === 'PRODUCT_SHOT' && e.image).length === 3 && images.every((c) => !/SAREE FACTS/.test(c.text)) && images.some((c) => c.refs.includes('BLOUSE')), [Date.now() - t0, images.map((c) => c.refs)]);
      delete process.env.SAREE_LOOK_BUDGET_MS; readerDelayMs = 0; readerFor = () => READ_PLAIN;
    }

    // 7d. A different saree among the extras: refused in the stream, nothing drawn.
    images.length = 0; sameChecks.length = 0;
    sameSareeFor = () => ({ same_saree: false, certain: true, evidence: 'a plain green saree' });
    const wrong = streamRes();
    await handler({ body: { clientId: 'shots-only-test-2', saree, sareeExtras: [blouse], productShotsOnly: true }, account: 'test-acct', headers: {}, on() {} }, wrong);
    const err = wrong.events.find((e) => e.type === 'ERROR');
    check('ERROR SAREE_EXTRA_MISMATCH names extra photo 1 and why', err && err.code === 'SAREE_EXTRA_MISMATCH' && /Extra photo 1/.test(err.error) && err.details[0].extra === 1 && /green/.test(err.details[0].reason), err);
    check('no picture was drawn for the refused request', images.length === 0, images.length);
    sameSareeFor = () => ({ same_saree: true, evidence: 'same' });
  } catch (e) {
    check(`the run reached the end (stopped at: ${String(e && e.message || e).split('\n')[0]})`, false);
  } finally {
    server.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
