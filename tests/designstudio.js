// =============================================================================
// tests/designstudio.js — Design Studio, offline. Run from tests/run.js.
// =============================================================================
//
// Gemini and Cloudinary are replaced by fakes, so nothing leaves the process and
// nothing is billed. Everything else is real: validation, sharp image handling,
// the prompt, retries, Express, the SSE stream, admission, cancel.
//
const path = require('path');

module.exports = async function designStudioTests(ctx) {
  // AbortSignal.timeout() timers do not keep Node alive. A test that waits only on
  // one (the hanging download) would let the process exit silently with code 0.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await runAll(ctx);
  } finally {
    clearInterval(keepAlive);
  }
};

async function runAll({ check, eq, section, SRC }) {
  // Settings are read at load: set them before anything from the service is required.
  Object.assign(process.env, {
    GEMINI_API_KEY: 'AIzaFAKE_TEST_KEY_never_sent_anywhere_000',
    DESIGNSTUDIO_RETRY_BASE_MS: '5',
    DESIGNSTUDIO_HEARTBEAT_MS: '60',
    DESIGNSTUDIO_DOWNLOAD_TIMEOUT_MS: '400',
    DESIGNSTUDIO_MAX_BODY_MB: '3',
    DESIGNSTUDIO_MAX_IMAGE_MB: '2'
  });
  const express = require('express');
  const sharp = require('sharp');
  const S = (p) => require(path.join(SRC, 'services/designstudio', p));
  const { resolveRequest } = S('validate');
  const imageInput = S('imageInput');
  const { buildPrompt } = S('promptBuilder');
  const gemini = S('geminiImage');
  const { GUIDE, taxonomy } = S('garmentGuide');
  const routes = S('routes');
  const { identify } = require(path.join(SRC, 'middleware/identity'));
  const capacity = require(path.join(SRC, 'lib/capacity'));

  const png = async (w, h, color = '#8a1c2b', alpha = false) =>
    (await sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { r: 200, g: 20, b: 40, alpha: 0.3 } : color } }).png().toBuffer()).toString('base64');
  const IMG = await png(900, 1200);
  const code = (fn) => { try { fn(); return 'OK'; } catch (e) { return e.code === 'VALIDATION_ERROR' && e.details ? e.details[0].code : e.code || e.message; } };
  const body = (over = {}) => ({ clientId: 'c1', garment: 'SAREE', designs: [{ area: 'PALLU', image: IMG }], ...over });

  // ── VALIDATION ─────────────────────────────────────────────────────────────
  section('DESIGN STUDIO: REQUEST CHECKS  (nothing is decoded or downloaded yet)');
  const aliasJob = resolveRequest(body({ garment: 'lehenga', designs: [{ area: 'ghagra', image: IMG }, { area: 'kinari', image: IMG }] }));
  eq('garment and area aliases resolve to canonical ids', [aliasJob.garmentId, aliasJob.designs.map((d) => d.areaId)], ['LEHANGA', ['SKIRT', 'BORDER']]);
  eq('unknown garment', code(() => resolveRequest(body({ garment: 'jacket' }))), 'UNKNOWN_GARMENT');
  eq('an area that does not belong to the garment (sleeve on a saree)', code(() => resolveRequest(body({ designs: [{ area: 'SLEEVE', image: IMG }] }))), 'UNKNOWN_DESIGN_AREA');
  eq('two designs for the same area, even spelled differently (pallu + aanchal)',
    code(() => resolveRequest(body({ designs: [{ area: 'pallu', image: IMG }, { area: 'aanchal', image: IMG }] }))), 'DUPLICATE_DESIGN_AREA');
  eq('no designs', code(() => resolveRequest(body({ designs: [] }))), 'INVALID_FIELD');
  eq('seven designs (limit 6)', code(() => resolveRequest(body({ designs: Array.from({ length: 7 }, () => ({ area: 'PALLU', image: IMG })) }))), 'INVALID_FIELD');
  eq('four fabrics (limit 3)', code(() => resolveRequest(body({ fabrics: Array.from({ length: 4 }, () => ({ image: IMG })) }))), 'INVALID_FIELD');
  eq('two fabrics both claiming to be the main fabric', code(() => resolveRequest(body({ fabrics: [{ image: IMG }, { image: IMG }] }))), 'MULTIPLE_MAIN_FABRICS');
  eq('two fabrics for the same area', code(() => resolveRequest(body({ fabrics: [{ image: IMG, appliesTo: ['BORDER'] }, { image: IMG, appliesTo: ['border', 'PALLU'] }] }))), 'FABRIC_AREA_CONFLICT');
  eq('a fabric for an area the garment does not have', code(() => resolveRequest(body({ fabrics: [{ image: IMG, appliesTo: ['COLLAR_NECK'] }] }))), 'UNKNOWN_DESIGN_AREA');
  eq('a plain http link', code(() => resolveRequest(body({ designs: [{ area: 'PALLU', image: 'http://res.cloudinary.com/x/image/upload/a.jpg' }] }))), 'INSECURE_URL');
  eq('a Pinterest link (only Cloudinary links are downloaded)', code(() => resolveRequest(body({ designs: [{ area: 'PALLU', image: 'https://i.pinimg.com/736x/a.jpg' }] }))), 'IMAGE_SOURCE_NOT_ALLOWED');
  eq('a look-alike host', code(() => resolveRequest(body({ designs: [{ area: 'PALLU', image: 'https://res.cloudinary.com.evil.example/a.jpg' }] }))), 'IMAGE_SOURCE_NOT_ALLOWED');
  eq('a link with credentials in it', code(() => resolveRequest(body({ designs: [{ area: 'PALLU', image: 'https://user:pw@res.cloudinary.com/a.jpg' }] }))), 'INVALID_URL');
  eq('Cloudinary shard hosts are allowed', code(() => resolveRequest(body({ designs: [{ area: 'PALLU', image: 'https://res-3.cloudinary.com/demo/image/upload/a.jpg' }] }))), 'OK');
  eq('text that is not base64', code(() => resolveRequest(body({ designs: [{ area: 'PALLU', image: 'hello, this is not an image at all but it is long enough to be checked' }] }))), 'INVALID_IMAGE_ENCODING');
  eq('a base64 image over the size limit', code(() => resolveRequest(body({ designs: [{ area: 'PALLU', image: 'A'.repeat(3 * 1024 * 1024) }] }))), 'IMAGE_TOO_LARGE');
  eq('an unknown field is refused, not silently ignored', code(() => resolveRequest(body({ colour: 'red' }))), 'INVALID_FIELD');
  eq('modelGender must be female or male', code(() => resolveRequest(body({ modelGender: 'robot' }))), 'INVALID_FIELD');
  eq('model defaults: saree -> woman, sherwani -> man, modelImage -> that person',
    [resolveRequest(body()).model, resolveRequest(body({ garment: 'SHERWANI', designs: [{ area: 'BUTTON', image: IMG }] })).model.gender, resolveRequest(body({ modelImage: IMG })).model.kind],
    [{ kind: 'generated', gender: 'female' }, 'male', 'reference']);
  check('error details name the exact field', (() => { try { resolveRequest(body({ fabrics: [{ image: IMG, appliesTo: ['NOPE'] }] })); } catch (e) { return e.details[0].field === 'fabrics[0].appliesTo[0]'; } })());

  section('DESIGN STUDIO: THE CATALOGUE-STYLE PAYLOAD  (product/parts/fabric details)');
  const catalogue = {
    clientId: 'shop-42', productType: 'saree', productName: 'Bridal Banarasi Saree',
    instructions: 'luxury boutique look',
    parts: [
      { type: 'pallu', label: 'Pallu', description: 'gold zari peacock motif', designImageUrl: IMG },
      { type: 'border', label: 'Border', description: 'wide temple border', designImageUrl: IMG }
    ],
    fabrics: [
      { imageUrl: IMG, appliesTo: ['body'], details: { itemCode: 'FAB-0003', name: 'Banarasi Brocade', material: 'Silk blend with zari', color: 'Wine', colorHex: '722f37', quantityMeters: 5.5 } },
      { imageUrl: IMG, appliesTo: ['pallu'], details: { itemCode: 'FAB-0011', name: 'Katan Silk', colour: 'Crimson Red', colorHex: '#DC143C', quantityMeters: 1.2 } }
    ]
  };
  const cat = resolveRequest(catalogue);
  eq('a catalogue-style payload resolves: productType/parts/type/designImageUrl/instructions',
    [cat.garmentId, cat.productName, cat.designs.map((d) => d.areaId), cat.designs[0].note, cat.notes],
    ['SAREE', 'Bridal Banarasi Saree', ['PALLU', 'BORDER'], 'gold zari peacock motif', 'luxury boutique look']);
  eq('fabric details are flattened, colour spelled either way, hex normalised, quantity and label ignored',
    cat.fabrics.map((f) => [f.itemCode, f.name, f.material, f.color, f.colorHex, f.appliesTo]),
    [['FAB-0003', 'Banarasi Brocade', 'Silk blend with zari', 'Wine', '#722F37', ['BODY']], ['FAB-0011', 'Katan Silk', null, 'Crimson Red', '#DC143C', ['PALLU']]]);
  eq('both spellings of the same request give the same job',
    JSON.stringify(resolveRequest({ clientId: 'shop-42', garment: 'SAREE', designs: [{ area: 'PALLU', image: IMG }] })),
    JSON.stringify(resolveRequest({ clientId: 'shop-42', productType: 'saree', parts: [{ type: 'pallu', designImageUrl: IMG }] })));
  eq('a bad hex colour is refused', code(() => resolveRequest(body({ fabrics: [{ image: IMG, colorHex: 'reddish' }] }))), 'INVALID_FIELD');
  eq('an unknown key inside details is still refused', code(() => resolveRequest({ clientId: 'c', productType: 'saree', parts: [{ type: 'pallu', designImageUrl: IMG }], fabrics: [{ imageUrl: IMG, details: { weirdField: 1 } }] })), 'INVALID_FIELD');

  // ── IMAGES ─────────────────────────────────────────────────────────────────
  section('DESIGN STUDIO: IMAGE PREPARATION  (real image decoding; Cloudinary faked)');
  const cloud = (p) => `https://res.cloudinary.com/demo/image/upload/${p}`;
  const bigPng = await png(3000, 2000, '#224466', true);
  const routesTable = new Map();
  const fakeCloud = async (url, opts) => {
    const handler = routesTable.get(url);
    if (!handler) return new Response('missing', { status: 404 });
    return handler(opts);
  };
  imageInput._setFetch(fakeCloud);
  const imageBytes = Buffer.from(IMG, 'base64');
  routesTable.set(cloud('ok.png'), async () => new Response(imageBytes, { status: 200, headers: { 'content-type': 'image/png' } }));
  let flaky = 0;
  routesTable.set(cloud('flaky.png'), async () => (++flaky === 1 ? new Response('oops', { status: 503 }) : new Response(imageBytes, { status: 200 })));
  routesTable.set(cloud('moved.png'), async () => new Response(null, { status: 302, headers: { location: cloud('ok.png') } }));
  routesTable.set(cloud('escape.png'), async () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }));
  routesTable.set(cloud('private.png'), async () => new Response('no', { status: 403 }));
  routesTable.set(cloud('huge.png'), async () => new Response('x', { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } }));
  routesTable.set(cloud('endless.png'), async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(256 * 1024)); }
  }), { status: 200 }));
  routesTable.set(cloud('hang.png'), (opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))));
  routesTable.set(cloud('notimage.png'), async () => new Response(Buffer.from('<html>login page</html>'.repeat(20)), { status: 200, headers: { 'content-type': 'image/png' } }));

  const prep = async (designs, extra = {}) => {
    const job = resolveRequest(body({ designs, ...extra }));
    try { return { job, images: await imageInput.prepareImages(job) }; } catch (e) { return { job, error: e }; }
  };

  let r = await prep([{ area: 'PALLU', image: bigPng }]);
  const sent = r.images && r.images[0];
  eq('a 3000x2000 transparent PNG becomes a 1536x1024 JPEG on white', sent && [sent.mimeType, sent.sent.width, sent.sent.height, sent.original.format], ['image/jpeg', 1536, 1024, 'png']);
  const corner = sent && await sharp(Buffer.from(sent.base64, 'base64')).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  check('transparency flattened onto white, not black', corner && corner[0] > 200 && corner[1] > 150, corner && `corner rgb ${[...corner].join(',')}`);

  const rotatedJpeg = (await sharp({ create: { width: 400, height: 200, channels: 3, background: '#ffffff' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer()).toString('base64');
  r = await prep([{ area: 'PALLU', image: rotatedJpeg }]);
  eq('a phone photo with EXIF rotation is measured and sent upright', r.images && [r.images[0].original.width, r.images[0].sent.width, r.images[0].sent.height], [200, 200, 400]);
  eq('...and flagged as low resolution (under 512px)', r.images && r.images[0].lowResolution, true);

  r = await prep([{ area: 'PALLU', image: await png(40, 40) }]);
  eq('a 40px image is refused', r.error && r.error.details[0].code, 'IMAGE_TOO_SMALL');
  r = await prep([{ area: 'PALLU', image: Buffer.from('this is definitely not an image, just bytes pretending'.repeat(4)).toString('base64') }]);
  eq('valid base64 that is not an image is refused', r.error && [r.error.status, r.error.details[0].code], [422, 'INVALID_IMAGE']);

  r = await prep([{ area: 'PALLU', image: cloud('ok.png') }]);
  eq('a Cloudinary link downloads and prepares', r.images && [r.images[0].from, r.images[0].sent.width], ['url', 900]);
  r = await prep([{ area: 'PALLU', image: cloud('flaky.png') }]);
  eq('a 503 from Cloudinary is retried once', [!!r.images, flaky], [true, 2]);
  r = await prep([{ area: 'PALLU', image: cloud('moved.png') }]);
  eq('a redirect within Cloudinary is followed', !!r.images, true);
  r = await prep([{ area: 'PALLU', image: cloud('escape.png') }]);
  eq('a redirect to any other host is refused (no way around the allowlist)', r.error && r.error.details[0].code, 'IMAGE_SOURCE_NOT_ALLOWED');
  r = await prep([{ area: 'PALLU', image: cloud('gone.png') }]);
  eq('404', r.error && r.error.details[0].code, 'IMAGE_NOT_FOUND');
  r = await prep([{ area: 'PALLU', image: cloud('private.png') }]);
  eq('403', r.error && r.error.details[0].code, 'IMAGE_NOT_ACCESSIBLE');
  r = await prep([{ area: 'PALLU', image: cloud('huge.png') }]);
  eq('a declared 50 MB file is refused before downloading', r.error && r.error.details[0].code, 'IMAGE_TOO_LARGE');
  r = await prep([{ area: 'PALLU', image: cloud('endless.png') }]);
  eq('a file with no declared size is cut off at the limit', r.error && r.error.details[0].code, 'IMAGE_TOO_LARGE');
  const t0 = Date.now();
  r = await prep([{ area: 'PALLU', image: cloud('hang.png') }]);
  check('a download that hangs stops at the time limit, without a second wait', r.error && r.error.details[0].code === 'IMAGE_DOWNLOAD_FAILED' && Date.now() - t0 < 1500,
    r.error && `${r.error.details[0].message} after ${Date.now() - t0}ms`);
  r = await prep([{ area: 'PALLU', image: cloud('notimage.png') }]);
  eq('a link that serves a web page instead of an image is refused', r.error && r.error.details[0].code, 'INVALID_IMAGE');
  r = await prep([{ area: 'PALLU', image: cloud('gone.png') }, { area: 'BORDER', image: await png(30, 30) }], { fabrics: [{ image: cloud('private.png') }] });
  eq('every broken image is reported at once, each by field', r.error && r.error.details.map((d) => `${d.field}:${d.code}`),
    ['designs[0].image:IMAGE_NOT_FOUND', 'designs[1].image:IMAGE_TOO_SMALL', 'fabrics[0].image:IMAGE_NOT_ACCESSIBLE']);

  // Ten very detailed images: the total sent to the model must stay under its limit.
  const noisy = async (seed) => {
    const w = 1536, h = 1536, px = Buffer.alloc(w * h * 3);
    let s = seed;
    for (let i = 0; i < px.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; px[i] = s & 0xff; }
    return { base64: (await sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer()).toString('base64'), sent: { width: w, height: h } };
  };
  const heavy = await Promise.all(Array.from({ length: 10 }, (_, i) => noisy(i + 1)));
  const before = heavy.reduce((s, x) => s + x.base64.length, 0);
  await imageInput.fitRequestBudget(heavy);
  const after = heavy.reduce((s, x) => s + x.base64.length, 0);
  check('ten highly detailed images are compressed to fit the model\'s request limit (14 MB)', before > 14 * 1024 * 1024 && after <= 14 * 1024 * 1024 && heavy.some((x) => x.shrunkToFit),
    `${(before / 1024 / 1024).toFixed(1)} MB -> ${(after / 1024 / 1024).toFixed(1)} MB`);
  const light = [{ base64: IMG, sent: { width: 900, height: 1200 } }];
  await imageInput.fitRequestBudget(light);
  eq('normal images are left untouched', [light[0].base64 === IMG, !!light[0].shrunkToFit], [true, false]);

  // ── PROMPT ─────────────────────────────────────────────────────────────────
  section('DESIGN STUDIO: PROMPT  (every garment, every design area)');
  const prepared = { mimeType: 'image/jpeg', base64: 'AAAA', original: { width: 1200, height: 1600 }, sent: { width: 1152, height: 1536, bytes: 3 }, lowResolution: false };
  const fakeJob = (garmentId, areaIds, extra = {}) => {
    const job = resolveRequest({ clientId: 'p', garment: garmentId, designs: areaIds.map((a) => ({ area: a, image: IMG })), ...extra });
    for (const d of job.designs) d.image = prepared;
    for (const f of job.fabrics) f.image = prepared;
    if (job.model.kind === 'reference') job.model.image = prepared;
    return job;
  };
  let bad = [];
  let pairs = 0;
  for (const g of taxonomy.GARMENTS) {
    for (const area of taxonomy.getDesignTypes(g.id)) {
      pairs++;
      const p = buildPrompt(fakeJob(g.id, [area.id]));
      if (/undefined|null|\[object|NaN/.test(p.text)) bad.push(`${g.id}/${area.id}`);
    }
  }
  eq(`all ${pairs} garment/area pairs build a clean prompt`, bad, []);
  eq('every garment has a guide', taxonomy.GARMENT_IDS.filter((id) => !GUIDE[id]), []);

  const full = buildPrompt(fakeJob('SAREE', ['PALLU', 'BORDER', 'ZARI_WORK'], {
    fabrics: [{ image: IMG, name: 'Kanjivaram silk' }, { image: IMG, name: 'Tissue', appliesTo: ['PALLU'] }],
    notes: 'make it "festive"\n\nand rich'
  }));
  const imageParts = full.parts.filter((p) => p.inlineData).length;
  eq('each reference image is sent once, right after its label', [imageParts, full.imageCount, full.parts.findIndex((p) => p.inlineData) > 0], [5, 5, true]);
  const labels = full.text.match(/\[Image \d\] [A-Z]+/g);
  eq('labels are numbered in order and say what each image is', labels, ['[Image 1] DESIGN', '[Image 2] DESIGN', '[Image 3] DESIGN', '[Image 4] FABRIC', '[Image 5] FABRIC']);
  check('a fabric for one area says so; the main fabric covers the rest',
    /FABRIC: Tissue\nUsed for: PALLU \(Pallu Design\) only\./.test(full.text) && /FABRIC: Kanjivaram silk\nUsed for: the main fabric/.test(full.text));
  check('area placement is spelled out (pallu over the left shoulder)', /falls from the left shoulder/.test(full.text));
  check('an area design wins over the overall/finish designs, stated only when both exist',
    /always wins inside that area/.test(full.text) && !/always wins inside that area/.test(buildPrompt(fakeJob('SAREE', ['PALLU'])).text));
  check('customer notes come last, flattened, and cannot break out of their quotes', /The customer also asked: "make it 'festive' and rich"/.test(full.text) && full.text.indexOf('CUSTOMER NOTES') > full.text.indexOf('QUALITY BAR'));
  check('portrait 3:4, head to toe, plain studio backdrop', /in 3:4, showing the model from head to toe/.test(full.text) && /plain studio backdrop/.test(full.text));

  const detailed = fakeJob('SAREE', ['PALLU', 'BODY'], {
    productName: 'Bridal Banarasi Saree',
    fabrics: [
      { image: IMG, name: 'Banarasi Brocade', material: 'Silk blend with zari work', color: 'Wine', colorHex: '#722F37', itemCode: 'FAB-0003', appliesTo: ['BODY'] },
      { image: IMG, name: 'Katan Silk', colorHex: '#DC143C', appliesTo: ['PALLU'] }
    ]
  });
  const detailedText = buildPrompt(detailed).text;
  check('the fabric label carries its code, material and stated colour',
    /FABRIC: Banarasi Brocade \[FAB-0003\]/.test(detailedText) && /Material: Silk blend with zari work/.test(detailedText) && /Colour: Wine, hex #722F37\. That is this fabric's exact colour/.test(detailedText), detailedText.split('[Image 3]')[1].split('\n\n')[0]);
  check('a hex-only fabric still states its colour', /Colour: hex #DC143C/.test(detailedText));
  check('stated colour and material become rules, and the product name is a style hint only',
    /that colour is the truth/.test(detailedText) && /build that part of the garment from that material/.test(detailedText)
    && /sold as "Bridal Banarasi Saree"/.test(detailedText) && /never draw any text into the image/.test(detailedText));
  check('without colours or materials those rules are not added', !/that colour is the truth/.test(full.text) && !/build that part of the garment from that material/.test(full.text));

  const back = buildPrompt(fakeJob('BLOUSE', ['BACK']));
  eq('a BACK design turns the model so the back is visible', [back.pose, /looking back over the shoulder/.test(back.text)], ['back', true]);
  const both = buildPrompt(fakeJob('KURTHI', ['FRONT', 'BACK']));
  eq('FRONT and BACK together: back pose plus an honest warning', [both.pose, both.warnings.length], ['back', 1]);
  const backAndNeck = buildPrompt(fakeJob('KURTHI', ['BACK', 'NECK', 'PRINT']));
  check('any front-facing area behind a BACK pose is named in the warning (measured: a NECK design was invisible)',
    backAndNeck.warnings.length === 1 && /leaves NECK partly or fully hidden/.test(backAndNeck.warnings[0]) && !/PRINT/.test(backAndNeck.warnings[0]),
    backAndNeck.warnings[0]);
  eq('a BACK design on its own needs no warning', buildPrompt(fakeJob('KURTHI', ['BACK'])).warnings, []);
  const ref = buildPrompt(fakeJob('SAREE', ['PALLU'], { modelImage: IMG }));
  check('a model photo: dress that exact person, ignore their outfit', /Dress the exact person shown in \[Image 2\]/.test(ref.text) && /ignore their original outfit/.test(ref.text));
  check('a model photo without a gender is "a model", not assumed', /photograph of a model wearing/.test(ref.text));
  check('sherwani: a man, his mid-twenties', /a man in his mid-twenties/.test(buildPrompt(fakeJob('SHERWANI', ['BUTTON'])).text));
  check('no fabric given: the model is told to choose one, not left to guess', /No fabric reference was given/.test(buildPrompt(fakeJob('GOWN', ['NECK'])).text));
  const low = fakeJob('SAREE', ['PALLU']);
  low.designs[0].image = { ...prepared, lowResolution: true, original: { width: 330, height: 440 } };
  eq('a low-resolution design produces a warning naming it', buildPrompt(low).warnings, ['designs[0] (PALLU) is only 440px; fine detail in that design may be lost.']);

  // ── GEMINI CALL ────────────────────────────────────────────────────────────
  section('DESIGN STUDIO: IMAGE MODEL CALL  (Gemini faked; retries, refusals, drafts)');
  const FINAL = await png(768, 1024, '#336699');
  const DRAFT = await png(64, 64, '#ff0000');
  gemini._setSleep(async () => {});
  const answer = (parts, extra = {}) => new Response(JSON.stringify({ candidates: [{ content: { parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 1300 }, ...extra }), { status: 200 });
  const imagePart = (data, thought = false) => ({ inlineData: { mimeType: 'image/png', data }, ...(thought ? { thought: true } : {}) });
  const script = (steps) => {
    const calls = [];
    gemini._setFetch(async (url, opts) => {
      calls.push({ url, opts, body: JSON.parse(opts.body) });
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      return typeof step === 'function' ? step(opts) : step();
    });
    return calls;
  };
  const run = async () => { try { return await gemini.generateImage([{ text: 'x' }]); } catch (e) { return { error: e }; } };

  let calls = script([() => answer([{ text: 'Planning the drape', thought: true }, imagePart(DRAFT, true), { text: 'Here it is.' }, imagePart(FINAL)])]);
  let out = await run();
  eq('the final image is returned, never the draft "thinking" image', out.image && [out.image.width, out.image.height, out.image.mimeType], [768, 1024, 'image/jpeg']);
  const sentBody = calls[0].body;
  eq('asks for a 3:4 image at 2K, image and text allowed', [sentBody.generationConfig.imageConfig, sentBody.generationConfig.responseModalities], [{ aspectRatio: '3:4', imageSize: '2K' }, ['TEXT', 'IMAGE']]);
  eq('temperature left at the model\'s own default', sentBody.generationConfig.temperature, undefined);
  check('the key goes in a header, never in the URL', calls[0].opts.headers['x-goog-api-key'] && !/key=/.test(calls[0].url) && /gemini-3\.1-flash-image:generateContent$/.test(calls[0].url), calls[0].url);
  eq('usage (tokens) is kept for cost tracking', out.usage, { promptTokenCount: 5000, candidatesTokenCount: 1300 });

  calls = script([() => new Response('busy', { status: 503 }), () => new Response('slow down', { status: 429 }), () => answer([imagePart(FINAL)])]);
  out = await run();
  eq('busy (503, then 429) is retried until it works', [!!out.image, out.attempts], [true, 3]);
  calls = script([() => new Response('busy', { status: 503 })]);
  out = await run();
  eq('still busy after all retries: 424 MODEL_UNAVAILABLE, 3 attempts, marked retryable', [out.error.status, out.error.code, calls.length, out.error.retryable], [424, 'MODEL_UNAVAILABLE', 3, true]);
  // Seen for real: a spent spending cap arrives as 429, exactly like "too busy".
  calls = script([() => new Response(JSON.stringify({ error: { code: 429, message: 'Your project has exceeded its monthly spending cap. Please go to AI Studio to manage your project spend cap.' } }), { status: 429 })]);
  out = await run();
  eq('a spending cap is reported at once, not retried three times', [out.error.code, out.error.status, calls.length, out.error.retryable], ['MODEL_QUOTA_EXCEEDED', 424, 1, false]);
  check('and the message tells an operator what to do', /spending cap or quota/.test(out.error.message), out.error.message);
  calls = script([() => new Response(JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).' } }), { status: 429 }), () => answer([imagePart(FINAL)])]);
  out = await run();
  eq('a plain rate-limit 429 is still retried', [!!out.image, calls.length], [true, 2]);
  calls = script([() => { throw new TypeError('fetch failed: socket hang up'); }, () => answer([imagePart(FINAL)])]);
  out = await run();
  eq('a dropped connection is retried', [!!out.image, calls.length], [true, 2]);
  calls = script([() => new Response('<html>502', { status: 200 }), () => answer([imagePart(FINAL)])]);
  out = await run();
  eq('an unreadable 200 is retried', [!!out.image, calls.length], [true, 2]);
  calls = script([() => answer([], { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })]);
  out = await run();
  eq('a refused request is reported, not retried (it would fail and cost again)', [out.error.code, out.error.status, calls.length, out.error.details], ['GENERATION_BLOCKED', 422, 1, { reason: 'PROHIBITED_CONTENT' }]);
  calls = script([() => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'I cannot' }] }, finishReason: 'IMAGE_SAFETY' }] }), { status: 200 })]);
  out = await run();
  eq('an image safety stop is a refusal too', [out.error.code, calls.length], ['GENERATION_BLOCKED', 1]);
  calls = script([() => answer([{ text: 'Sure! Here is a description of the saree.' }]), () => answer([imagePart(FINAL)])]);
  out = await run();
  eq('an answer with no image gets one more try', [!!out.image, calls.length], [true, 2]);
  calls = script([() => answer([{ text: 'only words' }])]);
  out = await run();
  eq('no image twice: NO_IMAGE_RETURNED (retryable), no endless loop', [out.error.code, calls.length, out.error.retryable], ['NO_IMAGE_RETURNED', 2, true]);
  calls = script([() => new Response(JSON.stringify({ error: { message: 'Request contains an invalid argument.' } }), { status: 400 })]);
  out = await run();
  eq('a 400 is not retried', [out.error.code, calls.length], ['GENERATION_REJECTED', 1]);
  calls = script([() => new Response(JSON.stringify({ error: { message: 'API key not valid. key=AIzaSyLEAKLEAKLEAKLEAKLEAKLEAK' } }), { status: 403 })]);
  out = await run();
  check('a bad key is 424 and the caller never sees the provider\'s message', out.error.code === 'MODEL_UNAVAILABLE' && out.error.status === 424 && !/AIza|key/i.test(out.error.message), out.error.message);
  const ac = new AbortController();
  calls = script([(opts) => new Promise((_, reject) => { opts.signal.addEventListener('abort', () => reject(opts.signal.reason)); setTimeout(() => ac.abort(), 20); })]);
  try { out = await gemini.generateImage([{ text: 'x' }], { signal: ac.signal }); } catch (e) { out = { error: e }; }
  eq('cancelling mid-call stops it and says CANCELLED', [out.error.code, calls.length], ['CANCELLED', 1]);

  // ── HTTP + STREAM ──────────────────────────────────────────────────────────
  section('DESIGN STUDIO: ENDPOINT AND STREAM  (real Express, fake Gemini)');
  const logs = [];
  const realLog = console.log, realWarn = console.warn, realError = console.error;
  console.log = (...a) => logs.push(a.join(' ')); console.warn = console.log; console.error = console.log;

  const app = express();
  app.use(identify);
  app.use('/ds', routes);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/ds`;
  let account = 0;
  const post = (p, payload, { signal, headers = {} } = {}) => fetch(base + p, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-gateway-client-id': `studio-acct-${++account}`, ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload)
  });
  const readEvents = async (res) => {
    const text = await res.text();
    return { text, events: text.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6))) };
  };

  try {
    const opt = await (await fetch(base + '/options')).json();
    eq('GET /options lists 12 garments with their areas, limits and 3:4', [opt.garments.length, opt.garments.find((g) => g.id === 'SAREE').designAreas.length, opt.limits.maxDesigns, opt.model.aspectRatio, opt.garments.find((g) => g.id === 'SHERWANI').defaultModelGender],
      [12, 8, 6, '3:4', 'male']);

    let res = await post('/generate', { clientId: 'x', garment: 'SAREE', designs: [{ area: 'SLEEVE', image: IMG }] });
    let json = await res.json();
    eq('a bad request is a JSON 400 with the field named', [res.status, json.error.code, json.error.details[0].field], [400, 'VALIDATION_ERROR', 'designs[0].area']);
    res = await post('/generate', '{"clientId": "x", ');
    eq('broken JSON is 400 INVALID_JSON', [res.status, (await res.json()).error.code], [400, 'INVALID_JSON']);
    res = await post('/generate', { clientId: 'x', garment: 'SAREE', designs: [{ area: 'PALLU', image: 'A'.repeat(4 * 1024 * 1024) }] });
    eq('a body over the limit is 413', [res.status, (await res.json()).error.code], [413, 'PAYLOAD_TOO_LARGE']);
    res = await post('/generate', { clientId: 'x', garment: 'SAREE', designs: [{ area: 'PALLU', image: cloud('gone.png') }] });
    json = await res.json();
    eq('a broken image is 422 before any stream opens, and nothing is charged', [res.status, json.error.code, /json/.test(res.headers.get('content-type'))], [422, 'IMAGE_UNUSABLE', true]);
    res = await fetch(base + '/nope');
    eq('an unknown path is a JSON 404', [res.status, (await res.json()).error.code], [404, 'NOT_FOUND']);

    // Happy path, with a draft image and a busy first answer.
    calls = script([() => new Response('busy', { status: 503 }), () => answer([imagePart(DRAFT, true), imagePart(FINAL)])]);
    res = await post('/generate', {
      clientId: 'shop-1', garment: 'saree',
      designs: [{ area: 'PALLU', image: IMG }, { area: 'BORDER', image: cloud('ok.png'), note: 'keep the peacocks' }],
      fabrics: [{ image: IMG, name: 'Banarasi silk' }]
    });
    eq('a good request opens an event stream', [res.status, res.headers.get('content-type')], [200, 'text/event-stream; charset=utf-8']);
    let { events } = await readEvents(res);
    eq('events: start, status (attempt 1), status (retry), image, done', events.map((e) => e.type), ['start', 'status', 'status', 'image', 'done']);
    const start = events[0];
    eq('start says what will be made', [start.garment, start.designs.map((d) => d.area), start.fabrics[0].appliesTo, start.model, start.pose, start.aspectRatio], ['SAREE', ['PALLU', 'BORDER'], 'MAIN', 'generated', 'front', '3:4']);
    const imageEvent = events.find((e) => e.type === 'image');
    const decoded = imageEvent && await sharp(Buffer.from(imageEvent.image.split(',')[1], 'base64')).metadata();
    eq('the image is a real base64 JPEG data URI of the final picture', decoded && [imageEvent.image.slice(0, 23), decoded.format, decoded.width, decoded.height, imageEvent.width], ['data:image/jpeg;base64,', 'jpeg', 768, 1024, 768]);
    const doneEvent = events[events.length - 1];
    check('done reports attempts and timings', doneEvent.status === 'ok' && doneEvent.attempts === 2 && doneEvent.timings.totalMs >= doneEvent.timings.generateMs, JSON.stringify(doneEvent.timings));
    const sentParts = calls[calls.length - 1].body.contents[0].parts;
    eq('Gemini received 3 images (2 designs, 1 fabric) with their labels', sentParts.filter((p) => p.inlineData).length, 3);
    eq('the capacity slot is given back afterwards', capacity.stats().activeGenerations, 0);

    // A refusal inside the stream.
    script([() => answer([], { promptFeedback: { blockReason: 'SAFETY' } })]);
    ({ events } = await readEvents(await post('/generate', body())));
    eq('a refusal arrives as an error event and the stream ends, no image', [events.map((e) => e.type), events[events.length - 1].code], [['start', 'status', 'error'], 'GENERATION_BLOCKED']);

    // Slow generation: heartbeat, capacity (1 slot in this test run), cancel.
    let geminiSignal = null;
    const slow = () => script([(opts) => new Promise((resolve, reject) => {
      geminiSignal = opts.signal;
      const timer = setTimeout(() => resolve(answer([imagePart(FINAL)])), 700);
      opts.signal.addEventListener('abort', () => { clearTimeout(timer); reject(opts.signal.reason); });
    })]);
    slow();
    const running = post('/generate', body({ clientId: 'slow-client' }), { headers: { 'x-gateway-client-id': 'acct-cancel' } });
    await new Promise((r) => setTimeout(r, 200));
    const busy = await post('/generate', body({ clientId: 'someone-else' }));
    const busyJson = await busy.json();
    eq('while the only slot is busy, another customer gets 429 with Retry-After', [busy.status, busy.headers.get('retry-after'), /capacity/.test(busyJson.error)], [429, '10', true]);
    const wrongOwner = await (await post('/cancel', { clientId: 'slow-client' }, { headers: { 'x-gateway-client-id': 'acct-other' } })).json();
    eq('another customer cannot cancel it', wrongOwner.cancelled, false);
    const cancelled = await (await post('/cancel', { clientId: 'slow-client' }, { headers: { 'x-gateway-client-id': 'acct-cancel' } })).json();
    const slowResult = await readEvents(await running);
    eq('the owner cancels: the stream ends with CANCELLED and Gemini is told to stop',
      [cancelled.cancelled, slowResult.events[slowResult.events.length - 1].code, geminiSignal && geminiSignal.aborted], [true, 'CANCELLED', true]);
    check('keep-alive pings were sent while it worked', /: keepalive \d+/.test(slowResult.text));

    slow();
    const leaving = new AbortController();
    const leaverRes = await post('/generate', body({ clientId: 'leaver' }), { signal: leaving.signal });
    const reader = leaverRes.body.getReader();
    await reader.read();
    leaving.abort();
    await new Promise((r) => setTimeout(r, 150));
    eq('a caller who disconnects stops the Gemini call and frees the slot', [geminiSignal && geminiSignal.aborted, capacity.stats().activeGenerations], [true, 0]);

    res = await post('/cancel', {});
    eq('cancel without clientId is 400', res.status, 400);
    script([() => answer([imagePart(FINAL)])]);
    ({ events } = await readEvents(await post('/generate', body({ clientId: 'after' }))));
    eq('the service works normally after all of that', events.map((e) => e.type), ['start', 'status', 'image', 'done']);

    check('no log line contains the API key or raw base64', !logs.some((l) => /AIzaFAKE|AIzaSyLEAK/.test(l) || /[A-Za-z0-9+/]{400,}/.test(l)), `${logs.length} log lines checked`);
    check('every request is logged once with its outcome', logs.filter((l) => /\[DesignStudio\] requestId=.* outcome=OK/.test(l)).length >= 2);
  } finally {
    console.log = realLog; console.warn = realWarn; console.error = realError;
    gemini._setFetch((...a) => fetch(...a));
    imageInput._setFetch((...a) => fetch(...a));
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
};
