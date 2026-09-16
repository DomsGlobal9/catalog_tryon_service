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
    DESIGNSTUDIO_MAX_IMAGE_MB: '2',
    // Short, so the "it hangs" cases finish in milliseconds instead of minutes.
    DESIGNSTUDIO_ATTEMPT_TIMEOUT_MS: '1000',
    DESIGNSTUDIO_DEADLINE_MS: '5000'
  });
  const express = require('express');
  const sharp = require('sharp');
  const S = (p) => require(path.join(SRC, 'services/designstudio', p));
  const { resolveRequest } = S('validate');
  const imageInput = S('imageInput');
  const { buildPrompt, referenceList } = S('promptBuilder');
  const describe = S('describeReferences');
  const gemini = S('geminiImage');
  const { GUIDE, taxonomy, GLOBAL_AREAS } = S('garmentGuide');
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
  // Each of these pins a flaw seen in a real generated photograph.
  check('no part may appear twice (a real saree came back with two pallus)',
    /Exactly one complete saree, with exactly one of each of its parts/.test(full.text) && /exactly ONE pallu/.test(full.text) && /Do not show a pallu on the right side/.test(full.text));
  check('recognisable motifs must survive (a temple border became plain zari bands)',
    /temple or mandir outlines, peacocks, paisleys/.test(full.text) && /Never replace them with generic zari stripes/.test(full.text));
  check('a reference\'s background colour must not become the garment\'s colour (a pink pallu photo beat a crimson fabric)',
    /colours OF THE MOTIFS only/.test(full.text) && /never from the design reference's own background/.test(full.text));
  check('a brocade or jaal fabric must not flatten into plain cloth', /that texture must still read across that part of the garment/.test(full.text));
  check('...but where both exist for one part, the design wins over the fabric\'s own pattern (measured: a jaal fabric erased the body butis)',
    /the DESIGN decides what that part looks like/.test(full.text) && /must never replace or crowd out the design's motifs/.test(full.text));
  check('a mannequin in a reference is ignored like a person or watermark', /a person, a mannequin, another garment, a background, hands, text or a watermark/.test(full.text));

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

  section('DESIGN STUDIO: PER-PART CONTROLS AND THE DESCRIBE STEP');
  const controlled = resolveRequest(body({
    designs: [
      { area: 'PALLU', image: IMG },
      { area: 'BORDER', image: IMG, groundColourHex: 'dc143c', keepMotifColours: false, coverage: 'reference' }
    ]
  }));
  eq('per-part controls resolve, British spellings included, with sensible defaults',
    controlled.designs.map((d) => [d.groundColorHex, d.keepMotifColors, d.coverage]),
    [[null, true, 'full'], ['#DC143C', false, 'reference']]);
  eq('a bad ground hex is refused', code(() => resolveRequest(body({ designs: [{ area: 'PALLU', image: IMG, groundColorHex: 'ivory' }] }))), 'INVALID_FIELD');
  eq('an unknown coverage value is refused', code(() => resolveRequest(body({ designs: [{ area: 'PALLU', image: IMG, coverage: 'partial' }] }))), 'INVALID_FIELD');

  const ctrlJob = fakeJob('SAREE', ['PALLU', 'BORDER']);
  ctrlJob.designs[1].groundColorHex = '#F2E8DC';
  ctrlJob.designs[1].keepMotifColors = false;
  ctrlJob.designs[1].coverage = 'reference';
  const ctrlText = buildPrompt(ctrlJob).text;
  check('a stated ground colour beats the reference photo\'s own colour (the navy collar case)',
    /Ground colour for this part: hex #F2E8DC - from the caller\./.test(ctrlText) && /reference photo's own background colour must NOT appear/.test(ctrlText));
  // Measured: a mustard sleeve reference made mint sleeves mustard, and a blue
  // gota reference made a rust lehenga's hem blue, because no ground was stated.
  const autoGround = buildPrompt(fakeJob('KURTHI', ['SLEEVE', 'NECK'], {
    fabrics: [{ image: IMG, name: 'Mint cotton silk', color: 'mint green', colorHex: '#9CC5AE' }]
  })).text;
  eq('with no ground stated, every designed part takes the colour from its fabric automatically',
    (autoGround.match(/Ground colour for this part: mint green, hex #9CC5AE - from its fabric \(Mint cotton silk\)\./g) || []).length, 2);
  eq('a part whose fabric states no colour gets no invented ground line',
    (buildPrompt(fakeJob('KURTHI', ['SLEEVE'], { fabrics: [{ image: IMG, name: 'Some silk' }] })).text.match(/Ground colour for this part/g) || []).length, 0);
  check('motif colours are kept by default and recoloured only when asked',
    /Keep the motif colours exactly as they are in this reference, including multi-coloured motifs/.test(ctrlText)
    && /Recolour the motifs to suit this part's own fabric palette/.test(ctrlText));
  check('a design covers its whole part by default (the blank pallu end case), unless the caller wants the reference layout',
    /covers the whole of this part, edge to edge and right to its end/.test(ctrlText) && /including any plain areas it shows/.test(ctrlText));
  check('the saree pallu itself must not end in a plain block', /The pallu must never end in a large plain block of fabric/.test(ctrlText));

  eq('references are numbered once, in the order the model sees them',
    referenceList(fakeJob('SAREE', ['PALLU', 'BORDER'], { fabrics: [{ image: IMG, name: 'silk' }], modelImage: IMG })).map((r) => `${r.ref}:${r.kind}`),
    ['1:design', '2:design', '3:fabric', '4:model']);

  const describeAnswer = (payload, status = 200) => async () => new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status });
  const goodDescription = {
    candidates: [{ content: { parts: [{ text: JSON.stringify({ references: [
      { ref: 1, motifs: 'temple (mandir) spires, 14 across the band', layout: 'continuous band', colours: 'gold on teal', technique: 'woven zari', notes: 'hexagonal jaal fills the band' },
      { ref: 2, motifs: 'tiny multi-coloured flower butis' }
    ] }) }] } }]
  };
  describe._setFetch(describeAnswer(goodDescription));
  let described = await describe.describeReferences(referenceList(fakeJob('SAREE', ['PALLU', 'BORDER'])));
  eq('the describe step turns the references into words', [described.size, described.get(1).motifs, described.get(2).motifs],
    [2, 'temple (mandir) spires, 14 across the band', 'tiny multi-coloured flower butis']);
  const withWords = buildPrompt(fakeJob('SAREE', ['PALLU', 'BORDER']), { descriptions: described }).text;
  check('and those words go to the image model next to the picture',
    /Motifs in this reference: temple \(mandir\) spires, 14 across the band/.test(withWords) && /Must not be missed: hexagonal jaal/.test(withWords));

  section('DESIGN STUDIO: ONLY THE NAMED PART OF A REFERENCE, AND EVERY REFERENCE DESCRIBED');
  // Measured: a SLEEVE reference that was a whole printed kurti gave the blouse
  // its neckline embroidery and rose print too; the describe step had written
  // "neckline has tiny dots" for it. And one real run described only the fabric.
  const refsOf = referenceList(fakeJob('BLOUSE', ['SLEEVE', 'OVERALL'], { fabrics: [{ image: IMG, name: 'Rust silk' }], modelImage: IMG }));
  eq('each design reference names its one part in words', refsOf.map((r) => r.part), ['sleeve of the blouse', 'whole blouse', undefined, undefined]);
  check('the describe label says to describe only that part',
    /Reference 1 - DESIGN for sleeve of the blouse\. Describe ONLY the sleeve of the blouse in this photograph:/.test(describe.labelFor(refsOf[0]))
    && /Reference 3 - FABRIC \(Rust silk\)\. Describe the cloth itself:/.test(describe.labelFor(refsOf[2])));

  let asked = [];
  const recordingFetch = (answers) => async (url, opts) => {
    const request = JSON.parse(opts.body);
    asked.push(request);
    const next = answers[Math.min(asked.length - 1, answers.length - 1)];
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(next) }] }, finishReason: 'STOP' }] }), { status: 200 });
  };
  const one = (ref, motifs) => ({ ref, motifs, layout: '', colours: '', technique: '', notes: '' });
  describe._setFetch(recordingFetch([{ references: [one(1, 'roses'), one(2, 'paisley'), one(3, 'plain')] }]));
  asked = [];
  await describe.describeReferences(refsOf);
  const askText = asked[0].contents[0].parts.filter((p) => p.text).map((p) => p.text).join('\n');
  eq('a model photo is never asked to the describe step (a person is not a design)',
    asked[0].contents[0].parts.filter((p) => p.inlineData).length, 3);
  check('the describe instructions forbid describing other parts, other garments, or the person\'s hair and jewellery',
    /describe ONLY the named part/.test(askText) && /its neckline, body, print, border, hem/.test(askText)
    && /a saree, dupatta, skirt or trousers worn with it/.test(askText) && /their hair, hair flowers, jewellery or makeup/.test(askText));
  check('the answer shape is enforced with a response schema, and thinking is capped so it cannot eat the answer',
    asked[0].generationConfig.responseSchema.properties.references.items.required.includes('ref')
    && asked[0].generationConfig.thinkingConfig.thinkingBudget === 1024 && asked[0].generationConfig.maxOutputTokens === 6144);

  eq('ref numbers are read leniently ("Reference 2", "3")',
    [...describe.readAnswer({ references: [one('Reference 2', 'a'), one('3', 'b')] }, [{ ref: 1 }, { ref: 2 }, { ref: 3 }]).keys()], [2, 3]);
  eq('entries with no usable ref are matched by position only when there is one per reference',
    [[...describe.readAnswer({ references: [one(null, 'a'), one('x', 'b')] }, [{ ref: 4 }, { ref: 5 }]).keys()],
      [...describe.readAnswer({ references: [one(null, 'a')] }, [{ ref: 4 }, { ref: 5 }]).keys()]],
    [[4, 5], []]);
  eq('a retry of one reference that the model renumbers "1" still lands on the right reference',
    [...describe.readAnswer({ references: [one(1, 'a')] }, [{ ref: 3 }]).keys()], [3]);
  eq('a ref that was not asked about is ignored when positions cannot be trusted',
    [...describe.readAnswer({ references: [one(9, 'a'), one(2, 'b')] }, [{ ref: 1 }]).keys()], []);

  describe._setFetch(recordingFetch([{ references: [one(3, 'plain crimson')] }, { references: [one(1, 'border vines'), one(2, 'brocade end')] }]));
  asked = [];
  const refsDupatta = referenceList(fakeJob('DUPATTA', ['BORDER', 'PALLU_END'], { fabrics: [{ image: IMG, name: 'Crimson organza' }] }));
  const recovered = await describe.describeReferences(refsDupatta);
  eq('references missing from the answer are asked about once more, on their own (the "only the fabric" run)',
    [[...recovered.keys()].sort(), asked.length, asked[1].contents[0].parts.filter((p) => p.inlineData).length], [[1, 2, 3], 2, 2]);
  describe._setFetch(recordingFetch([{ references: [one(1, 'a'), one(2, 'b'), one(3, 'c')] }]));
  asked = [];
  await describe.describeReferences(refsDupatta);
  eq('a complete answer is not asked twice', asked.length, 1);

  const sleeveText = buildPrompt(fakeJob('BLOUSE', ['SLEEVE', 'NECK'])).text;
  check('a whole-garment photo: take only the named part, never listing that part as one to ignore, and move no embellishment across',
    /If it shows a whole garment or outfit, take ONLY its sleeve: every other part of it - its neckline, body, all-over print, borders, hem, and any other garment worn with it - is NOT part of this reference/.test(sleeveText)
    && /take ONLY its neck: every other part of it - its sleeves, body, all-over print, borders, hem,/.test(sleeveText)
    && /no embellishment from those other parts is moved onto this part/.test(sleeveText));
  // Measured the other way: flat artwork was read as "does not show a border",
  // and the notes (peacocks) replaced the pictures (dots).
  check('flat artwork, a swatch or a close-up is the whole design for that part',
    /If this photograph is a close-up, a flat swatch, trim or artwork rather than a whole garment, the whole picture is the design for the sleeve of the blouse/.test(sleeveText));
  check('the picture outranks its own customer note', /This picture decides the design\. Where a customer note describes something different from the picture, follow the picture\./.test(sleeveText));
  check('a BACK design owns the back neckline, a FRONT design its neckline and hem',
    /take ONLY its back: every other part of it - its sleeves, all-over print, borders, hem,/.test(buildPrompt(fakeJob('BLOUSE', ['BACK'])).text)
    && /take ONLY its front: every other part of it - its sleeves, all-over print, borders,/.test(buildPrompt(fakeJob('KURTHI', ['FRONT'])).text)
    && !/\bhem\b/.test((buildPrompt(fakeJob('KURTHI', ['FRONT'])).text.match(/take ONLY its front: every other part of it - (.*?), and any other garment/) || [])[1] || 'hem'));
  check('the describe step is told a non-garment picture IS the design, never "does not show the part"',
    /If the photograph is NOT a garment - a close-up, a flat swatch, a strip of trim, a piece of artwork/.test(askText) && /Never answer that the photograph does not show the part/.test(askText));
  eq('an answer that only says the part is not in the photo is not a description (so it gets asked again)',
    [...describe.readAnswer({ references: [{ ref: 1, motifs: '', layout: '', colours: '', technique: '', notes: 'The photograph does not depict a saree border.' }, one(2, 'dots')] }, [{ ref: 1 }, { ref: 2 }]).keys()], [2]);
  check('an OVERALL or PRINT reference is the whole garment, so it gets no "only this part" line',
    !/take ONLY/.test(buildPrompt(fakeJob('SAREE', ['OVERALL'])).text) && !/take ONLY/.test(buildPrompt(fakeJob('KURTHI', ['PRINT'])).text));
  check('motifs stay inside their own part, and nothing is added that a reference does not show',
    /their motifs, colours and embellishments are never borrowed from one part into the other/.test(sleeveText)
    && /no extra butis, flowers, pearl or bead drops, fringes, tassels, latkans, lace, piping, sequins or stones/.test(sleeveText));
  check('nothing is copied from the people in the reference photos (the gajra case)',
    /not their hairstyle, hair flowers or gajra, jewellery, bindi or makeup\. No flowers or accessories in the hair/.test(sleeveText));
  check('a dupatta\'s two ends are identical (one came out gold, the other red on red)',
    /two ends are identical: the same end design in the same colours and metallic finish, and the same tassels where it has them/.test(buildPrompt(fakeJob('DUPATTA', ['PALLU_END', 'TASSEL'])).text)
    && /Both ends carry this same design/.test(buildPrompt(fakeJob('DUPATTA', ['PALLU_END'])).text));
  section('DESIGN STUDIO: THE 9-GARMENT CHECK  (faults seen in real generations)');
  // A suit came out with a dupatta: "only if a design reference asks for one" was
  // not enough. Presence is decided from the designs sent.
  const suitText = buildPrompt(fakeJob('SUIT', ['NECK', 'SLEEVE'])).text;
  check('no DUPATTA design: an explicit "no dupatta" for every garment that could grow one, and no "only if" wording left anywhere',
    /- No dupatta, stole, shawl or scarf of any kind\./.test(suitText)
    && ['GOWN', 'SHARARA', 'ANARKALI', 'KURTHI', 'SAREE'].every((id) => /No dupatta, stole, shawl or scarf/.test(buildPrompt(fakeJob(id, [taxonomy.getDesignTypes(id).find((a) => !GLOBAL_AREAS.has(a.id)).id])).text))
    && taxonomy.GARMENT_IDS.every((id) => !JSON.stringify(GUIDE[id]).includes('dupatta only if')));
  check('a DUPATTA design adds exactly one dupatta carrying it; a lehenga keeps its own dupatta; a dupatta is not told it has no dupatta',
    /Add one dupatta, carrying the DUPATTA design reference\./.test(buildPrompt(fakeJob('ANARKALI', ['NECK', 'DUPATTA'])).text)
    && !/No dupatta, stole/.test(buildPrompt(fakeJob('ANARKALI', ['NECK', 'DUPATTA'])).text)
    && !/No dupatta, stole/.test(buildPrompt(fakeJob('LEHANGA', ['SKIRT'])).text)
    && !/No dupatta, stole/.test(buildPrompt(fakeJob('DUPATTA', ['BORDER'])).text));
  check('a dupatta gets tassels only from a TASSEL design (two dupattas grew tassels unasked)',
    /No tassels or latkans on the dupatta, and no fringe unless a design reference shows one/.test(buildPrompt(fakeJob('DUPATTA', ['BORDER', 'CORNER'])).text)
    && !/No tassels or latkans/.test(buildPrompt(fakeJob('DUPATTA', ['BORDER', 'TASSEL'])).text)
    && !/and its tassels are all clearly visible/.test(buildPrompt(fakeJob('DUPATTA', ['BORDER'])).text));
  check('the close framings say the legs and feet are out of frame (two dupattas were shot head to toe)',
    /the ankles and feet are NOT in it/.test(buildPrompt(fakeJob('DUPATTA', ['BORDER'])).text)
    && /the knees, legs and feet are NOT in it/.test(buildPrompt(fakeJob('BLOUSE', ['NECK'])).text));
  check('borrowing is named part by part (gota cuffs came from a neck reference photo)',
    /not on its sleeves, cuffs, neckline, hem or any other part without a design of its own/.test(suitText));
  check('lace and cutwork keep their shapes (hearts appeared) and show only their own ground (a lilac print showed through lace)',
    /Never introduce a shape the reference does not have, such as hearts, stars, letters or animals/.test(suitText)
    && /what shows through is that part's own ground colour - never the cloth, print or skin seen through it/.test(suitText));

  // A red embroidered yoke on a blue kurta came out indigo (the fabric). A
  // contrast panel keeps its colour; a part photographed on a same-colour garment
  // still takes the fabric colour (the mustard-sleeve case must not come back).
  const yokeJob = fakeJob('SUIT', ['NECK', 'SLEEVE'], { fabrics: [{ image: IMG, name: 'Indigo cotton', color: 'indigo', colorHex: '#2F3E6B' }] });
  const yoke = buildPrompt(yokeJob, { descriptions: new Map([
    [1, { motifs: 'triangles', groundType: 'contrast panel', groundColour: 'deep red' }],
    [2, { motifs: 'rose cutwork', groundType: 'garment fabric', groundColour: '' }]
  ]) });
  check('a contrast panel keeps its own colour, says so, and tells the caller how to change it',
    /Ground colour for this part: deep red\. In its reference this part is a separately coloured contrast panel, so it keeps that panel colour instead of the fabric's colour/.test(yoke.text)
    && yoke.warnings.some((w) => /NECK is a contrast panel in its reference, so it keeps its own colour \(deep red\) instead of the fabric colour\. To choose its colour, send designs\[0\]\.groundColorHex/.test(w)));
  check('a part on the garment\'s own cloth still takes the fabric colour (the mustard-sleeve fix holds)',
    /Ground colour for this part: indigo, hex #2F3E6B - from its fabric \(Indigo cotton\)\./.test(yoke.text));
  const yokeCaller = fakeJob('SUIT', ['NECK'], { fabrics: [{ image: IMG, color: 'indigo' }] });
  yokeCaller.designs[0].groundColorHex = '#F2E8DC';
  check('the caller\'s ground colour still beats a contrast panel',
    /Ground colour for this part: hex #F2E8DC - from the caller\./.test(buildPrompt(yokeCaller, { descriptions: new Map([[1, { motifs: 'x', groundType: 'contrast panel', groundColour: 'deep red' }]]) }).text));
  check('the describe step is asked whether a part is a contrast panel, with a fixed set of answers',
    /"contrast panel" ONLY when the named part is a yoke, panel, patch, band or appliqué whose background is a clearly DIFFERENT colour/.test(askText)
    && JSON.stringify(asked[0].generationConfig.responseSchema.properties.references.items.properties.groundType.enum) === JSON.stringify(['contrast panel', 'garment fabric', 'not applicable']));
  eq('the contrast answer survives parsing', describe.readAnswer({ references: [{ ref: 1, motifs: 'triangles', groundType: 'contrast panel', groundColour: 'deep red' }] }, [{ ref: 1 }]).get(1).groundColour, 'deep red');

  check('a supporting piece gets no band or trim either (a saree border showed at the blouse sleeve edges)',
    /not even a narrow band or trim at a sleeve edge, neckline or hem/.test(buildPrompt(fakeJob('SAREE', ['BORDER'])).text));
  describe._setFetch(describeAnswer(goodDescription));

  // A patterned fabric on a part that also has a design: warn, and tell the model
  // which one wins. Measured: a brocade jaal erased the body's butis.
  const clashJob = fakeJob('SAREE', ['BODY'], { fabrics: [{ image: IMG, name: 'Banarasi Brocade', appliesTo: ['BODY'] }] });
  const clashPrompt = buildPrompt(clashJob, { descriptions: new Map([[2, { motifs: 'floral jaal', technique: 'woven zari brocade, all-over jaal design' }]]) });
  check('a patterned fabric over a designed part is flagged to the caller and settled in the prompt',
    clashPrompt.warnings.length === 1 && /BODY has both a design and a patterned fabric \(Banarasi Brocade/.test(clashPrompt.warnings[0])
    && /send a plainer fabric for BODY/.test(clashPrompt.warnings[0]) && /THIS design's motifs are what must be seen on BODY/.test(clashPrompt.text),
    clashPrompt.warnings[0]);
  const calmJob = fakeJob('SAREE', ['BODY'], { fabrics: [{ image: IMG, name: 'Plain wine silk', appliesTo: ['BODY'] }] });
  eq('a plain fabric on the same part raises nothing (a sparkly velvet must not cry wolf)',
    buildPrompt(calmJob, { descriptions: new Map([[2, { motifs: 'none, plain cloth', technique: 'plain silk with a soft sheen' }]]) }).warnings, []);

  describe._setFetch(describeAnswer({ candidates: [{ content: { parts: [{ text: '```json\n{"references":[{"ref":1,"motifs":"paisley"}]}\n```' }] } }] }));
  eq('an answer wrapped in code fences is still read', (await describe.describeReferences(referenceList(fakeJob('SAREE', ['PALLU'])))).get(1).motifs, 'paisley');
  describe._setFetch(describeAnswer({ candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: '{"references":[{"ref":1,"colours":"wine"}]}' }] } }] }));
  eq('thinking output is skipped', (await describe.describeReferences(referenceList(fakeJob('SAREE', ['PALLU'])))).get(1).colours, 'wine');
  for (const [name, fake] of [
    ['the model answers with prose instead of JSON', describeAnswer({ candidates: [{ content: { parts: [{ text: 'Sure! Here is a lovely description.' }] } }] })],
    ['the describe call fails (HTTP 500)', describeAnswer('boom', 500)],
    ['the describe call throws', async () => { throw new TypeError('fetch failed'); }]
  ]) {
    describe._setFetch(fake);
    const empty = await describe.describeReferences(referenceList(fakeJob('SAREE', ['PALLU'])));
    eq(`${name}: skipped, generation still goes ahead`, empty.size, 0);
  }

  section('DESIGN STUDIO: THE PRODUCT AND WHAT IT IS WORN WITH');
  // Measured: the prompt said the blouse was "plain unless a design reference
  // describes it", and a saree's pallu design (gold dots) came out on the blouse.
  const { pairing } = S('promptBuilder');
  eq('every garment says what it is worn with (null only when it is the whole outfit)',
    taxonomy.GARMENT_IDS.filter((id) => GUIDE[id].pairedWith === undefined), []);
  eq('whole-outfit garments pair with nothing', ['GOWN', 'SUIT', 'SHARARA'].map((id) => GUIDE[id].pairedWith), [null, null, null]);
  eq('a saree is worn with a blouse, a blouse with a saree, a petticoat with a blouse',
    ['SAREE', 'BLOUSE', 'PETTICOAT', 'LEHANGA'].map((id) => GUIDE[id].pairedWith.pieces), ['blouse', 'skirt', 'blouse', 'choli and dupatta']);
  eq('no garment keeps the "plain unless a design reference describes it" loophole',
    taxonomy.GARMENT_IDS.filter((id) => /unless a design reference (describes|covers)/.test(`${GUIDE[id].styling}`)), []);

  const sareePair = buildPrompt(fakeJob('SAREE', ['PALLU', 'BORDER'], {
    fabrics: [{ image: IMG, name: 'Plain wine silk', color: 'wine', colorHex: '#722F37' }]
  })).text;
  check('saree: the saree is the only product, and every design belongs to it',
    /The saree is the only product in this photograph\. Every design reference below belongs to the saree and to nothing else/.test(sareePair));
  check('saree: the blouse is named as NOT the product, and no reference may appear on it',
    /The blouse is NOT the product: it only completes the photograph/.test(sareePair)
    && /No design reference applies to the blouse\. None of the references' motifs, borders, buttis, prints, embroidery, mirror work or zari may appear on it/.test(sareePair));
  check('saree: by default the blouse matches the main fabric colour exactly',
    /Colour of the blouse: wine, hex #722F37 \(from the saree's main fabric\) - match it exactly\./.test(sareePair));
  check('saree with no fabric colour: the blouse still follows the main fabric, in words',
    /Colour of the blouse: the same colour as the saree's main fabric\./.test(buildPrompt(fakeJob('SAREE', ['PALLU'])).text));
  check('the worn-with block sits after the garment and before the design rules',
    sareePair.indexOf('THE GARMENT') < sareePair.indexOf('WHAT THE MODEL WEARS WITH IT')
    && sareePair.indexOf('WHAT THE MODEL WEARS WITH IT') < sareePair.indexOf('HOW TO USE THE DESIGN REFERENCES'));

  const pairJob = resolveRequest(body({ garment: 'BLOUSE', designs: [{ area: 'NECK', image: IMG }], pairWith: { colour: 'cream', colourHex: 'f3ead7', description: 'soft chiffon' } }));
  eq('pairWith resolves, British spellings and description included, hex normalised',
    pairJob.pairWith, { color: 'cream', colorHex: '#F3EAD7', note: 'soft chiffon' });
  eq('pairedWith is accepted as the same field', resolveRequest(body({ pairedWith: { color: 'gold' } })).pairWith.color, 'gold');
  eq('an empty pairWith is the same as none', resolveRequest(body({ pairWith: {} })).pairWith, null);
  eq('a bad pairWith hex is refused', code(() => resolveRequest(body({ pairWith: { colorHex: 'goldish' } }))), 'INVALID_FIELD');
  eq('an unknown key inside pairWith is refused', code(() => resolveRequest(body({ pairWith: { fabric: 'silk' } }))), 'INVALID_FIELD');

  const blouseJob = fakeJob('BLOUSE', ['NECK'], { pairWith: { color: 'cream', colorHex: '#F3EAD7', note: 'matte crepe' } });
  const blousePrompt = buildPrompt(blouseJob);
  const blousePair = blousePrompt.text;
  // Measured: with a saree, its pallu covered a third of the blouse front even
  // when told to pin it back. No saree at all now, and a close frame.
  check('blouse: no saree - only a plain skirt edge completes the photo, and nothing drapes over the blouse',
    /The skirt is NOT the product/.test(blousePair) && /only the waistband and a few centimetres below it are in the frame/.test(blousePair)
    && /No saree, no pallu, no dupatta and no drape of any kind/.test(blousePair) && !/pallu pinned back/.test(blousePair));
  check('blouse: the caller\'s pairWith colour and note decide the skirt',
    /Colour of the skirt: cream, hex #F3EAD7 \(from the caller\) - match it exactly\./.test(blousePair)
    && /Customer note for the skirt: matte crepe\. Follow it, but still put no design reference on it\./.test(blousePair));
  check('blouse with no pairWith: a quiet neutral skirt that is clearly not the blouse\'s colour',
    /Colour of the skirt: a quiet, solid neutral .* clearly different from the blouse's own colour/.test(buildPrompt(fakeJob('BLOUSE', ['NECK'])).text));

  section('DESIGN STUDIO: FRAMING  (the product fills the photograph)');
  eq('framing per garment: blouse waist-up, dupatta three-quarter, the rest full length',
    Object.fromEntries(taxonomy.GARMENT_IDS.map((id) => [id, GUIDE[id].framing])),
    { SAREE: 'full', BLOUSE: 'waist-up', DUPATTA: 'three-quarter', KURTHI: 'full', ANARKALI: 'full', PETTICOAT: 'full', GOWN: 'full', SUIT: 'full', SHERWANI: 'full', BOTTOM_WEAR: 'full', LEHANGA: 'full', SHARARA: 'full' });
  check('blouse: a waist-up photograph in which the blouse is never cropped, and not head to toe',
    blousePrompt.framing === 'waist-up' && /A waist-up portrait catalogue photograph in 3:4: the frame runs from a little above the head down to the upper thighs/.test(blousePair)
    && /The blouse itself is never cropped - all of it, including both sleeves and its full hem, is inside the frame/.test(blousePair)
    && !/head to toe/.test(blousePair) && !/fingers and feet/.test(blousePair));
  const dupattaPrompt = buildPrompt(fakeJob('DUPATTA', ['BORDER', 'TASSEL']));
  check('dupatta: three-quarter, so its hanging ends and tassels stay in frame (waist-up would cut them)',
    dupattaPrompt.framing === 'three-quarter' && /down to mid-calf/.test(dupattaPrompt.text)
    && /both of its hanging ends and any tassels are fully inside the frame/.test(dupattaPrompt.text) && !/head to toe/.test(dupattaPrompt.text));
  check('dupatta: worn over a plain kurta with no drape or border of its own',
    /The kurta is NOT the product/.test(dupattaPrompt.text) && /no drape, border or embellishment of its own/.test(dupattaPrompt.text));
  const backBlouse = buildPrompt(fakeJob('BLOUSE', ['BACK'])).text;
  check('a blouse BACK design keeps the close frame: the back pose no longer says "full length"',
    /Pose: standing, turned three-quarters away/.test(backBlouse) && /waist-up portrait/.test(backBlouse));
  check('full-length garments are unchanged: a saree head to toe with feet, a kurti back pose still full length',
    /head to toe/.test(full.text) && /fingers and feet/.test(full.text)
    && /Pose: standing full length, turned three-quarters away/.test(buildPrompt(fakeJob('KURTHI', ['BACK'])).text));
  eq('the caller\'s colour beats the matching default',
    pairing(fakeJob('SAREE', ['PALLU'], { fabrics: [{ image: IMG, colorHex: '#722F37' }], pairWith: { colorHex: '#C9A227' } })).colour, 'hex #C9A227');
  check('a fabric for one area is not mistaken for the main fabric\'s colour',
    /the same colour as the saree's main fabric/.test(buildPrompt(fakeJob('SAREE', ['PALLU'], { fabrics: [{ image: IMG, colorHex: '#DC143C', appliesTo: ['PALLU'] }] })).text));
  const plural = buildPrompt(fakeJob('LEHANGA', ['SKIRT'])).text;
  check('plural supporting pieces read naturally (lehenga: choli and dupatta)',
    /The choli and dupatta are NOT the product: they only complete the photograph/.test(plural) && /may appear on them/.test(plural));

  const gownPair = buildPrompt(fakeJob('GOWN', ['NECK'], { pairWith: { color: 'gold' } }));
  eq('a gown has nothing to pair: no worn-with block, and pairWith is reported as unused, not silently dropped',
    [/WHAT THE MODEL WEARS WITH IT/.test(gownPair.text), /only product in this photograph/.test(gownPair.text), gownPair.warnings],
    [false, false, ['pairWith was not used: a gown is the whole outfit, so nothing else is worn with it.']]);

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
  // Measured in a real run: one attempt hung past 120s while others took 25-61s.
  let slowCalls = 0;
  gemini._setFetch(async (url, opts) => {
    slowCalls++;
    if (slowCalls === 1) return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)));
    return answer([imagePart(FINAL)]);
  });
  out = await run();
  eq('a slow attempt is cut off and tried once more, and then succeeds', [!!out.image, slowCalls, out.attempts], [true, 2, 2]);
  gemini._setFetch(async (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))));
  out = await run();
  eq('if it hangs every time: MODEL_TIMEOUT, marked retryable, not an endless wait', [out.error.code, out.error.status, out.error.retryable], ['MODEL_TIMEOUT', 424, true]);

  const ac = new AbortController();
  calls = script([(opts) => new Promise((_, reject) => { opts.signal.addEventListener('abort', () => reject(opts.signal.reason)); setTimeout(() => ac.abort(), 20); })]);
  try { out = await gemini.generateImage([{ text: 'x' }], { signal: ac.signal }); } catch (e) { out = { error: e }; }
  eq('cancelling mid-call stops it and says CANCELLED', [out.error.code, calls.length], ['CANCELLED', 1]);

  // ── HTTP + STREAM ──────────────────────────────────────────────────────────
  section('DESIGN STUDIO: ENDPOINT AND STREAM  (real Express, fake Gemini)');
  const logs = [];
  const realLog = console.log, realWarn = console.warn, realError = console.error;
  console.log = (...a) => logs.push(a.join(' ')); console.warn = console.log; console.error = console.log;

  // The describe step runs before every generation; give it a fake too.
  describe._setFetch(describeAnswer(goodDescription));
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
    eq('GET /options says what each product is worn with, and the default colour',
      [opt.garments.find((g) => g.id === 'SAREE').pairedWith, opt.garments.find((g) => g.id === 'BLOUSE').pairedWith.pieces, opt.garments.find((g) => g.id === 'GOWN').pairedWith],
      [{ pieces: 'blouse', defaultColour: 'matches the main fabric' }, 'skirt', null]);
    eq('GET /options says how each garment is framed',
      ['SAREE', 'BLOUSE', 'DUPATTA'].map((id) => opt.garments.find((g) => g.id === id).framing), ['full', 'waist-up', 'three-quarter']);

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
    eq('events: start, reading references, brief, generating, retry, image, done',
      events.map((e) => e.type), ['start', 'status', 'brief', 'status', 'status', 'image', 'done']);
    eq('the brief event tells the caller what was understood from each reference',
      events[2].references.map((r) => r.ref), [1, 2]);
    eq('the first status is the describe step', events[1].stage, 'reading-references');
    const start = events[0];
    eq('start says what will be made', [start.garment, start.designs.map((d) => d.area), start.fabrics[0].appliesTo, start.model, start.pose, start.aspectRatio], ['SAREE', ['PALLU', 'BORDER'], 'MAIN', 'generated', 'front', '3:4']);
    eq('start says how the photograph is framed', start.framing, 'full');
    eq('start says what the model wears with the product, and where its colour came from',
      start.pairedWith, { pieces: 'blouse', colour: 'the same colour as the saree\'s main fabric', from: 'the default', note: null });
    const imageEvent = events.find((e) => e.type === 'image');
    const decoded = imageEvent && await sharp(Buffer.from(imageEvent.image.split(',')[1], 'base64')).metadata();
    eq('the image is a real base64 JPEG data URI of the final picture', decoded && [imageEvent.image.slice(0, 23), decoded.format, decoded.width, decoded.height, imageEvent.width], ['data:image/jpeg;base64,', 'jpeg', 768, 1024, 768]);
    const doneEvent = events[events.length - 1];
    check('done reports attempts and timings', doneEvent.status === 'ok' && doneEvent.attempts === 2 && doneEvent.timings.totalMs >= doneEvent.timings.generateMs, JSON.stringify(doneEvent.timings));
    const sentParts = calls[calls.length - 1].body.contents[0].parts;
    eq('Gemini received 3 images (2 designs, 1 fabric) with their labels', sentParts.filter((p) => p.inlineData).length, 3);
    eq('the capacity slot is given back afterwards', capacity.stats().activeGenerations, 0);

    // The describe step failing must not stop a generation.
    describe._setFetch(describeAnswer('service down', 503));
    script([() => answer([imagePart(FINAL)])]);
    ({ events } = await readEvents(await post('/generate', body({ clientId: 'no-brief' }))));
    eq('if the describe step fails there is no brief, and the image still arrives',
      [events.map((e) => e.type), events.some((e) => e.type === 'brief')], [['start', 'status', 'status', 'image', 'done'], false]);
    describe._setFetch(describeAnswer(goodDescription));

    // A refusal inside the stream.
    script([() => answer([], { promptFeedback: { blockReason: 'SAFETY' } })]);
    ({ events } = await readEvents(await post('/generate', body())));
    eq('a refusal arrives as an error event and the stream ends, no image', [events.map((e) => e.type), events[events.length - 1].code], [['start', 'status', 'brief', 'status', 'error'], 'GENERATION_BLOCKED']);

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
    eq('the service works normally after all of that', events.map((e) => e.type), ['start', 'status', 'brief', 'status', 'image', 'done']);

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
