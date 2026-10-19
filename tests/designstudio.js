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
    // The endpoint tests below read every event; the image-only default is tested on its own.
    DESIGNSTUDIO_STREAM_DETAIL: 'full',
    // Off by default in production to save cost; the tests exercise them switched on.
    DESIGNSTUDIO_CROP: 'on',
    DESIGNSTUDIO_QA: 'on',
    DESIGNSTUDIO_QA_MAX_REGENERATIONS: '1',
    DESIGNSTUDIO_IMAGE_SIZE: '2K',
    // Distinct from the default above, so a test can tell which one a request used.
    DESIGNSTUDIO_OWN_PHOTO_IMAGE_SIZE: '4K',
    DESIGNSTUDIO_DOWNLOAD_TIMEOUT_MS: '400',
    DESIGNSTUDIO_MAX_BODY_MB: '3',
    DESIGNSTUDIO_MAX_IMAGE_MB: '2',
    // Short, so the "it hangs" cases finish in milliseconds instead of minutes.
    DESIGNSTUDIO_ATTEMPT_TIMEOUT_MS: '1000',
    DESIGNSTUDIO_DEADLINE_MS: '5000',
    DESIGNSTUDIO_DESCRIBE_TIMEOUT_MS: '300',
    DESIGNSTUDIO_DESCRIBE_DEADLINE_MS: '3000'
  });
  const express = require('express');
  const sharp = require('sharp');
  const S = (p) => require(path.join(SRC, 'services/designstudio', p));
  const { resolveRequest } = S('validate');
  const imageInput = S('imageInput');
  const { buildPrompt, referenceList } = S('promptBuilder');
  const describe = S('describeReferences');
  const qa = S('qualityCheck');
  const crop = S('cropReferences');
  // The part finder answers "close-up" unless a test says otherwise: no test may reach the network.
  const locateAnswer = (view, box = []) => async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ view, box_2d: box }) }] } }] }), { status: 200 });
  crop._setFetch(locateAnswer('close-up of the part'));
  const gemini = S('geminiImage');
  const { GUIDE, taxonomy, GLOBAL_AREAS } = S('garmentGuide');
  const routes = S('routes');
  const { identify } = require(path.join(SRC, 'middleware/identity'));
  const capacity = require(path.join(SRC, 'lib/capacity'));

  const png = async (w, h, color = '#8a1c2b', alpha = false) =>
    (await sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { r: 200, g: 20, b: 40, alpha: 0.3 } : color } }).png().toBuffer()).toString('base64');
  const IMG = await png(900, 1200);
  const FINAL_B64 = await png(768, 1024, '#336699');
  const code = (fn) => { try { fn(); return 'OK'; } catch (e) { return e.code === 'VALIDATION_ERROR' && e.details ? e.details[0].code : e.code || e.message; } };
  const body = (over = {}) => ({ clientId: 'c1', garment: 'SAREE', designs: [{ area: 'PALLU', image: IMG }], ...over });

  // ── VALIDATION ─────────────────────────────────────────────────────────────
  section('DESIGN STUDIO: ON/OFF SWITCHES  (every switch reads the same words)');
  const { flag } = S('config');
  const read = (value, fallback) => { process.env.DS_TEST_FLAG = value; const quiet = console.warn; console.warn = () => {}; try { return flag('DS_TEST_FLAG', fallback); } finally { console.warn = quiet; delete process.env.DS_TEST_FLAG; } };
  eq('off / false / 0 / no all switch OFF a switch that defaults on (PAIR_CHECK=false used to stay on and keep paying)',
    ['off', 'false', '0', 'no', 'OFF', ' False '].map((v) => read(v, true)), [false, false, false, false, false, false]);
  eq('on / true / 1 / yes all switch ON a switch that defaults off (QA=true used to stay off)',
    ['on', 'true', '1', 'yes', 'ON'].map((v) => read(v, false)), [true, true, true, true, true]);
  eq('unset or unreadable keeps the default', [read('', true), read('', false), read('maybe', true), read('maybe', false)], [true, false, true, false]);

  section('DESIGN STUDIO: REQUEST CHECKS  (nothing is decoded or downloaded yet)');
  const aliasJob = resolveRequest(body({ garment: 'lehenga', designs: [{ area: 'ghagra', image: IMG }, { area: 'kinari', image: IMG }] }));
  eq('garment and area aliases resolve to canonical ids', [aliasJob.garmentId, aliasJob.designs.map((d) => d.areaId)], ['LEHANGA', ['SKIRT', 'BORDER']]);
  eq('unknown garment', code(() => resolveRequest(body({ garment: 'jacket' }))), 'UNKNOWN_GARMENT');
  eq('an area that does not belong to the garment (sleeve on a saree)', code(() => resolveRequest(body({ designs: [{ area: 'SLEEVE', image: IMG }] }))), 'UNKNOWN_DESIGN_AREA');
  eq('two designs for the same area, even spelled differently (pallu + aanchal)',
    code(() => resolveRequest(body({ designs: [{ area: 'pallu', image: IMG }, { area: 'aanchal', image: IMG }] }))), 'DUPLICATE_DESIGN_AREA');
  eq('no designs', code(() => resolveRequest(body({ designs: [] }))), 'INVALID_FIELD');
  eq('nine designs (limit 8)', code(() => resolveRequest(body({ designs: Array.from({ length: 9 }, () => ({ area: 'PALLU', image: IMG })) }))), 'INVALID_FIELD');
  // A real design-library saree (13 Oct) sent 7 parts and was refused at the old limit of 6.
  const libSaree = resolveRequest({ clientId: 'lib', garment_key: 'saree', parts: Object.fromEntries(
    [['pallu_design', 1], ['border_design', 2], ['body_design', 3], ['pleat_design', 4], ['print_design', 5], ['embroidery_design', 6], ['zari_work_design', 7]]
      .map(([part, sequence]) => [part, { part, sequence, image_url: IMG, caption: '', part_label: part }])) });
  eq('a 7-part design-library saree is accepted, every part on its own area in sequence order',
    libSaree.designs.map((d) => d.areaId), ['PALLU', 'BORDER', 'BODY', 'PLEAT', 'PRINT', 'EMBROIDERY', 'ZARI_WORK']);
  // The same library sends its main fabric as SAREE_BODY (19 Oct); it was silently dropped.
  eq('design-library fabric roles: SAREE_BODY is the main fabric, PALLU and BORDER cover their own parts - none dropped',
    resolveRequest({ clientId: 'lib', garment_key: 'saree', parts: { pallu_design: { part: 'pallu_design', sequence: 1, image_url: IMG } },
      fabrics: { SAREE_BODY: [IMG], PALLU: [IMG], BORDER: [IMG] } }).fabrics.map((f) => (f.appliesTo || ['MAIN']).join('+')),
    ['MAIN', 'PALLU', 'BORDER']);
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
  eq('model defaults: saree -> woman, sherwani -> woman too (a womens garment here; the mens one is in Catalog Try-On), modelImage -> that person',
    [resolveRequest(body()).model, resolveRequest(body({ garment: 'SHERWANI', designs: [{ area: 'BUTTON', image: IMG }] })).model.gender, resolveRequest(body({ modelImage: IMG })).model.kind],
    [{ kind: 'generated', gender: 'female' }, 'female', 'reference']);
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
    /A repeating pattern covers the whole of this part, edge to edge and right to its end/.test(ctrlText) && /including any plain areas it shows/.test(ctrlText));
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
    && asked[0].generationConfig.thinkingConfig.thinkingBudget === 4096 && asked[0].generationConfig.maxOutputTokens === 8192);

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
    /No tassels, latkans or pom-poms on the dupatta ends - even if a reference photograph of a whole dupatta shows them - and no fringe unless a design reference shows one/.test(buildPrompt(fakeJob('DUPATTA', ['BORDER', 'CORNER'])).text)
    && !/No tassels, latkans/.test(buildPrompt(fakeJob('DUPATTA', ['BORDER', 'TASSEL'])).text)
    && !/and its tassels are all clearly visible/.test(buildPrompt(fakeJob('DUPATTA', ['BORDER'])).text));
  check('the waist-up framing says the legs and feet are out of frame',
    /the knees, legs and feet are NOT in it/.test(buildPrompt(fakeJob('BLOUSE', ['NECK'])).text));
  // A three-quarter framing is still supported for a future garment, and says the
  // feet are out of frame. No garment uses it: dupattas were shot head to toe.
  const savedFraming = GUIDE.DUPATTA.framing;
  GUIDE.DUPATTA.framing = 'three-quarter';
  check('a three-quarter framing (still supported) keeps hanging ends in frame and says the feet are not',
    /down to mid-calf/.test(buildPrompt(fakeJob('DUPATTA', ['BORDER'])).text) && /the ankles and feet are NOT in it/.test(buildPrompt(fakeJob('DUPATTA', ['BORDER'])).text));
  GUIDE.DUPATTA.framing = savedFraming;
  check('borrowing is named part by part (gota cuffs came from a neck reference photo)',
    /not on its sleeves, cuffs, neckline, hem or any other part without a design of its own/.test(suitText));
  check('lace and cutwork keep their shapes (hearts appeared) and show only their own ground (a lilac print showed through lace)',
    /a round dot stays a round dot, a rose stays a rose, a leaf stays a leaf/.test(suitText) && !/hearts|stars|letters/i.test(suitText)
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

  section('DESIGN STUDIO: ROUND 2  (new designs and fabrics, faults seen in real generations)');
  // Two real runs lost their whole brief: one describe attempt hung past the
  // shared 25s limit and the retry had no time left. Each attempt now has its own.
  let describeCalls = 0;
  describe._setFetch(async (url, opts) => {
    describeCalls++;
    if (describeCalls === 1) {
      return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))));
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ references: [one(1, 'kalis'), one(2, 'gota')] }) }] } }] }), { status: 200 });
  });
  const hungStarted = Date.now();
  const recoveredAfterHang = await describe.describeReferences(referenceList(fakeJob('LEHANGA', ['SKIRT', 'BORDER'])));
  eq('one hung describe attempt no longer loses the brief: it is cut off and the retry still runs',
    [recoveredAfterHang.size, describeCalls, Date.now() - hungStarted < 2500], [2, 2, true]);
  describe._setFetch(describeAnswer(goodDescription));

  // A rust kurti got a green churidar and an emerald sherwani a black one - the
  // colours of garments in the reference photos. A petticoat's blouse was the
  // reference model's black crop T-shirt.
  const kurtiPair = buildPrompt(fakeJob('KURTHI', ['NECK'], { fabrics: [{ image: IMG, name: 'Rust raw silk', color: 'rust orange', colorHex: '#A6501E' }] })).text;
  check('a coordinating supporting piece is a tone of the product\'s own fabric colour, never a colour from a reference photo',
    /Colour of the churidar: a deeper or lighter tone of rust orange, hex #A6501E \(the kurti's own fabric colour\), or a quiet neutral - never a colour that appears only in a reference photograph/.test(kurtiPair));
  check('a contrasting supporting piece is also never a colour taken from a reference photo',
    /so the petticoat stands out - never a colour that appears only in a reference photograph/.test(buildPrompt(fakeJob('PETTICOAT', ['WAIST'])).text));
  check('no supporting piece copies the outfit of anyone in the reference photos',
    /The churidar is never copied from what anyone in the reference photographs is wearing - not its style, cut or colour/.test(kurtiPair)
    && /The choli and dupatta are never copied from what anyone in the reference photographs is wearing - not their style/.test(buildPrompt(fakeJob('LEHANGA', ['SKIRT'])).text));

  // A BORDER_HEM reference that was a dress dotted all over turned the whole gown skirt into dots.
  const hemJob = fakeJob('GOWN', ['BORDER_HEM', 'NECK']);
  const hem = buildPrompt(hemJob, { descriptions: new Map([[1, { motifs: 'black sequin dots', layout: 'scattered all over the entire dress', groundType: 'garment fabric' }]]) });
  check('an edge-area design stays a band however much of the garment its photo covers, and the caller is told',
    /This is an edge area\. However much of the garment its reference photograph covers, reproduce this design only as a band of realistic width along the border hem - never spread it over the rest of the gown/.test(hem.text)
    && hem.warnings.some((w) => /The BORDER_HEM reference shows a pattern across the whole garment rather than a border hem band, so it is used only as a band along the border hem/.test(w)));
  check('a neck or yoke is not squeezed into a band, and a real border reference raises no warning',
    (hem.text.match(/This is an edge area/g) || []).length === 1
    && buildPrompt(fakeJob('GOWN', ['BORDER_HEM']), { descriptions: new Map([[1, { motifs: 'floral scroll', layout: 'continuous band at the hem' }]]) }).warnings.length === 0);
  check('a dupatta hangs both ends down the front, side by side, as mirror images (3 of 4 came out with different ends)',
    /BOTH long ends hang straight down the front of the body, one over each shoulder, side by side and at the same height/.test(buildPrompt(fakeJob('DUPATTA', ['PALLU_END'])).text)
    && /The two ends hanging side by side are mirror images of each other/.test(buildPrompt(fakeJob('DUPATTA', ['PALLU_END'])).text));
  section('DESIGN STUDIO: ROUND 3  (real fabric photos, faults seen in real generations)');
  // An olive banarasi with small woven florets took over a third of a leheriya body.
  const floretJob = fakeJob('DUPATTA', ['BODY'], { fabrics: [{ image: IMG, name: 'Olive Banarasi silk' }] });
  const floret = buildPrompt(floretJob, { descriptions: new Map([[2, { motifs: 'Small diamond-shaped florets', technique: 'woven silk' }]]) });
  check('a fabric described with any motifs counts as patterned, not only brocade or jaal keywords',
    floret.warnings.some((w) => /BODY has both a design and a patterned fabric \(Olive Banarasi silk/.test(w)));
  eq('a fabric whose motifs are "none" or "plain" still raises nothing',
    ['none', 'Plain. No motifs.', '-', 'Solid colour'].map((m) => buildPrompt(fakeJob('DUPATTA', ['BODY'], { fabrics: [{ image: IMG, name: 'x' }] }), { descriptions: new Map([[2, { motifs: m }]]) }).warnings.length),
    [0, 0, 0, 0]);
  check('a dupatta BODY design runs the full length between the borders, up to both ends',
    /the whole field between the borders along its full length, right up to both decorated ends/.test(buildPrompt(fakeJob('DUPATTA', ['BODY'])).text));
  // A PALLU_END photo of a whole dupatta brought its tassels and body buttis along.
  const endOnly = buildPrompt(fakeJob('DUPATTA', ['PALLU_END', 'BORDER'])).text;
  check('no BODY design: the dupatta body stays plain, whatever a whole-dupatta photo shows',
    /The body of the dupatta between its borders and ends is plain fabric: no buttis, motifs or print from any reference photograph/.test(endOnly)
    && !/The body of the dupatta between its borders and ends is plain/.test(buildPrompt(fakeJob('DUPATTA', ['BODY'])).text));
  // A saree blouse came out with zari bands at the sleeves and neckline again.
  check('a saree blouse is cut from plain fabric, never from the saree border, pallu or body',
    /cut from plain solid fabric - never from the saree's woven border, pallu or body fabric/.test(buildPrompt(fakeJob('SAREE', ['BORDER'])).text));
  // A neckpiece appliqué on a FRONT design was stretched from the neck to the hem.
  check('a single placed piece is made once at its real size, never stretched to fill the part',
    /if this reference is ONE placed piece - a yoke, neckpiece, appliqué, patch or a single motif - make it once, at its real size and in its natural position; never stretch or repeat it to fill the part/.test(buildPrompt(fakeJob('KURTHI', ['FRONT'])).text));

  const tasselLeak = buildPrompt(fakeJob('DUPATTA', ['PALLU_END', 'BORDER']), { descriptions: new Map([[1, { motifs: 'floral branches', notes: 'purple silk tassels hang from the end' }]]) }).text;
  check('a reference that also shows tassels is named, and its tassels excluded (purple tassels came from a pallu-end photo twice)',
    /\[Image 1\] also shows tassels, latkans, pom-poms or a fringe\. They are NOT part of this design/.test(tasselLeak)
    && !/also shows tassels/.test(buildPrompt(fakeJob('DUPATTA', ['PALLU_END', 'TASSEL']), { descriptions: new Map([[1, { notes: 'tassels hang from the end' }]]) }).text));
  eq('a patterned fabric raises no clash warning on a trim (tassels and buttons are not cut from it)',
    buildPrompt(fakeJob('DUPATTA', ['TASSEL'], { fabrics: [{ image: IMG, name: 'Olive silk' }] }), { descriptions: new Map([[2, { motifs: 'woven florets' }]]) }).warnings, []);

  const frontJob = fakeJob('KURTHI', ['FRONT', 'NECK'], { fabrics: [{ image: IMG, name: 'Teal crepe', color: 'deep teal', colorHex: '#0F5E5A' }] });
  const frontContrast = buildPrompt(frontJob, { descriptions: new Map([[1, { motifs: 'mirror yoke', groundType: 'contrast panel', groundColour: 'black' }], [2, { motifs: 'gota', groundType: 'contrast panel', groundColour: 'red' }]]) });
  check('a FRONT is the garment itself, never a contrast panel (a teal kurti came out with a red front in production); a NECK still can be',
    /Ground colour for this part: deep teal, hex #0F5E5A - from its fabric/.test(frontContrast.text.split('[Image 2]')[0])
    && /Ground colour for this part: red\. In its reference this part is a separately coloured contrast panel/.test(frontContrast.text)
    && frontContrast.warnings.filter((w) => /contrast panel/.test(w)).length === 1);

  const sareeBand = buildPrompt(fakeJob('SAREE', ['BORDER'])).text;
  check('the saree border belongs to the saree only, and the final check names the blouse sleeve ends (bands came back three times)',
    /never repeated on the blouse, not as sleeve cuffs, not around the neckline/.test(sareeBand) && /a fitted SLEEVELESS blouse/.test(sareeBand)
    && /Final check on the blouse: it is one solid colour from edge to edge\. Look at the armholes and neckline: there is NO gold, zari, metallic or patterned band there/.test(sareeBand)
    && sareeBand.indexOf('Final check on the blouse') > sareeBand.indexOf('QUALITY BAR')
    && !/Final check on/.test(buildPrompt(fakeJob('GOWN', ['SLEEVE'])).text));

  const printed = buildPrompt(fakeJob('BLOUSE', ['BACK'], { fabrics: [{ image: IMG, color: 'navy', colorHex: '#1C2B5A' }] }), { descriptions: new Map([[1, { motifs: 'buttis', technique: 'Ajrakh block print, matte' }]]) }).text;
  check('a printed design is locked as a print (an ajrakh print came out as woven zari in production)',
    /TECHNIQUE LOCK: this design is PRINTED/.test(printed)
    && !/TECHNIQUE LOCK/.test(buildPrompt(fakeJob('BLOUSE', ['BACK']), { descriptions: new Map([[1, { technique: 'Woven zari brocade' }]]) }).text));
  check('the describe step is taught to tell a flat print from a weave', /flat, matte colour lying ON the cloth with no raised threads and no metallic glint is a PRINT/.test(askText));
  const stripes = buildPrompt(fakeJob('SAREE', ['BODY'], { fabrics: [{ image: IMG, color: 'emerald green', colorHex: '#0B6E4F' }] })).text;
  check('background-coloured stripes become the ground colour (blue stripes survived on an emerald saree in production)',
    /the stripes or blocks in the reference's background colour are ground, not motif: they become emerald green, hex #0B6E4F too/.test(stripes));

  check('the blouse sleeve ends are tested perceptually, and the blouse is not a matching blouse piece',
    /The blouse is sleeveless: its armholes and neckline are finished only with a narrow folded edge/.test(sareeBand) && /NOT a matching blouse piece cut from the saree/.test(sareeBand)
    && /The choli sleeve ends look exactly like the middle of the sleeve/.test(buildPrompt(fakeJob('LEHANGA', ['SKIRT'])).text)
    && !/sleeve ends look exactly like/.test(buildPrompt(fakeJob('KURTHI', ['NECK'])).text));

  section('DESIGN STUDIO: THE QUALITY GATE CHECKLIST');
  const stripeReview = buildPrompt(fakeJob('SAREE', ['BODY', 'PALLU'], { fabrics: [{ image: IMG, color: 'emerald green', colorHex: '#0B6E4F' }] }), { descriptions: new Map([
    [1, { motifs: 'stripes', colours: 'Background stripes: blue. Decorative stripes: gold zari.', technique: 'woven zari', groundType: 'garment fabric' }],
    [2, { motifs: 'buttis', colours: 'Motifs gold. Background is deep maroon red.', technique: 'Block print, matte', groundType: 'garment fabric' }]
  ]) }).review;
  const checklist = qa.buildChecklist(stripeReview);
  eq('a saree order is checked for: one person, framing, a plain blouse, no dupatta, no tassels, one pallu, reference colours, the print, no text',
    checklist.map((c) => c.id), ['one_person', 'framing', 'supporting_plain', 'no_dupatta', 'no_tassels', 'one_pallu', 'colour_body', 'colour_pallu', 'print_pallu', 'no_text']);
  check('the colour check names the reference background and its shades (light-blue stripes survived once)',
    /The design reference was photographed on blue\. Judge ONLY the ground[\s\S]*Is it true that blue - and any lighter or darker shade or tint of it - does NOT appear as a ground, stripe, band, check or block colour on the body of the saree/.test(checklist.find((c) => c.id === 'colour_body').question));
  check('a blouse is checked waist-up, a dupatta for tassels only without a TASSEL design, a gown for no supporting piece',
    qa.buildChecklist(buildPrompt(fakeJob('BLOUSE', ['BACK'])).review).some((c) => c.id === 'framing' && /waist-up/.test(c.question))
    && qa.buildChecklist(buildPrompt(fakeJob('DUPATTA', ['BORDER'])).review).some((c) => c.id === 'no_tassels')
    && !qa.buildChecklist(buildPrompt(fakeJob('DUPATTA', ['TASSEL'])).review).some((c) => c.id === 'no_tassels')
    && !qa.buildChecklist(buildPrompt(fakeJob('GOWN', ['NECK'])).review).some((c) => c.id === 'supporting_plain'));
  eq('colour families: a gold background on a gold ground is not checked; blue on emerald is',
    [qa.sameColourFamily('golden beige', 'antique gold #C9A227'), qa.sameColourFamily('deep maroon red', 'red #B3202A'), qa.sameColourFamily('blue', 'emerald green #0B6E4F')],
    [true, true, false]);
  check('the colour check says where the part is, so another part is not judged (the gold pallu was blamed on the border once)',
    /On the body of the saree \(the main body of the saree: the large field between the borders, seen on the pleats and wrapped around the hips\) - and only there, not on other parts of the garment/.test(checklist.find((c) => c.id === 'colour_body').question), checklist.find((c) => c.id === 'colour_body').question);
  check('the colour check allows motif, zari and gold colours and judges only the ground (gold zari was flagged once)',
    /Motifs, buttis, zari, gold or metallic work \(including a solid gold or zari panel or band\) and coloured decoration are allowed in any colour, and skin seen through sheer or net fabric is not a ground colour/.test(checklist.find((c) => c.id === 'colour_body').question));
  check('a contrast panel is not colour-checked against its own panel colour',
    !qa.buildChecklist(buildPrompt(fakeJob('SUIT', ['NECK'], { fabrics: [{ image: IMG, color: 'indigo' }] }), { descriptions: new Map([[1, { colours: 'Background is red.', groundType: 'contrast panel', groundColour: 'red' }]]) }).review).some((c) => c.id === 'colour_neck'));
  check('a lighter tint of the background colour is named as ground in the prompt too',
    /every lighter or darker shade or tint of that background colour/.test(buildPrompt(fakeJob('SAREE', ['BODY'], { fabrics: [{ image: IMG, color: 'emerald' }] })).text));

  // Round 5 (all 12 garments, real run): colour leaks the gate missed, and false alarms it raised.
  eq('colour families by closeness, not just words: cream is ivory, gold is mustard; navy-and-white is not lilac',
    [qa.sameColourFamily('off-white/cream', 'ivory #EDE3CC'), qa.sameColourFamily('gold', 'mustard yellow #D4A017'), qa.sameColourFamily('alternating navy blue and white', 'lilac #B7A2D6'), qa.sameColourFamily('black', 'lilac #B7A2D6'), qa.sameColourFamily('beige', 'wine #6D1A36')],
    [true, true, false, false, false]);
  const gownPrompt = buildPrompt(fakeJob('GOWN', ['WAIST', 'SKIRT_FLARE'], { fabrics: [{ image: IMG, color: 'lilac', colorHex: '#B7A2D6' }] }), { descriptions: new Map([
    [1, { motifs: '', colours: 'Solid black.', technique: 'woven', groundType: 'garment fabric', groundColour: 'black' }],
    [2, { motifs: 'Solid colour blocks.', colours: 'Navy blue and white tiers.', technique: 'woven', groundType: 'garment fabric', groundColour: 'alternating navy blue and white' }]
  ]) });
  check('the reference\'s own cloth colour is named and replaced in the prompt (a lilac gown came back with navy-and-white tiers and a black belt)',
    /In \[Image 2\] this part's cloth is alternating navy blue and white\. That is only the colour of the garment that was photographed: on the new gown every area of alternating navy blue and white on this part - its cloth, tiers, panels, cuffs, belts/.test(gownPrompt.text)
    && /In \[Image 1\] this part's cloth is black\./.test(gownPrompt.text), gownPrompt.text.slice(0, 400));
  eq('...and the gate checks both parts for it',
    qa.buildChecklist(gownPrompt.review).filter((c) => c.id.startsWith('colour_')).map((c) => c.id), ['colour_waist', 'colour_skirt_flare']);
  check('a reference already in the garment colour is not told to change (cream collar on an ivory sherwani)',
    !/this part's cloth is/.test(buildPrompt(fakeJob('SHERWANI', ['COLLAR_NECK'], { fabrics: [{ image: IMG, color: 'ivory', colorHex: '#EDE3CC' }] }), { descriptions: new Map([[1, { motifs: 'paisley', colours: 'Motif colour: cream-gold; background colour: off-white/cream.', technique: 'thread embroidery', groundType: 'garment fabric', groundColour: '' }]]) }).text));
  const photoFabric = buildPrompt(fakeJob('BLOUSE', ['SLEEVE'], { fabrics: [{ image: IMG, name: 'Real fabric' }] }), { descriptions: new Map([
    [1, { motifs: 'leaves', colours: 'Motifs: black; Background: sheer navy blue', technique: 'thread embroidery', groundType: 'garment fabric', groundColour: 'sheer navy blue' }],
    [2, { motifs: '', colours: 'Solid bright red', technique: 'woven', groundType: 'not applicable', groundColour: '' }]
  ]) });
  check('a fabric photo sent without a colour still sets the ground, from its own reading (blouse sleeves came out navy)',
    /Ground colour for this part: bright red - from its fabric photograph \(Real fabric\)/.test(photoFabric.text) && /this part's cloth is sheer navy blue/.test(photoFabric.text)
    && qa.buildChecklist(photoFabric.review).some((c) => c.id === 'colour_sleeve'), photoFabric.text.slice(0, 300));
  eq('print kinds: flat, foil, print with raised work, woven',
    ['Block print, matte', 'Printed, with a metallic sheen', 'Block print with mirror work, matte finish', 'Printed fabric base, embellished with stitched beads', 'woven zari brocade'].map((t) => S('promptBuilder').printKind(t)),
    ['flat', 'foil', 'embellished', 'embellished', null]);
  const mirrorPrint = buildPrompt(fakeJob('ANARKALI', ['NECK']), { descriptions: new Map([[1, { motifs: 'florals', technique: 'Block print with mirror work, matte finish', groundType: 'garment fabric' }]]) });
  check('a print with mirror work keeps its mirrors and is not inspected as a pure print (anarkali regenerated for nothing)',
    /PRINTED flat on the cloth, with the raised work named above/.test(mirrorPrint.text) && !/no embroidery, no raised texture/.test(mirrorPrint.text)
    && !qa.buildChecklist(mirrorPrint.review).some((c) => c.id === 'print_neck'));
  check('a generic "block print" gets the technique lock (a stray control character had limited it to ajrakh and kalamkari)',
    /TECHNIQUE LOCK: this design is PRINTED - flat, matte/.test(buildPrompt(fakeJob('SAREE', ['BODY']), { descriptions: new Map([[1, { motifs: 'buttis', technique: 'Block print, matte' }]]) }).text));
  const rack = buildPrompt(fakeJob('DUPATTA', ['CORNER']), { descriptions: new Map([[1, { motifs: 'many', technique: 'mixed', groundType: 'garment fabric', problem: 'The picture shows a shop rack of many different dupattas.' }]]) });
  check('an unusable reference (a shop rack of dupattas) is reported to the caller and kept simple in the prompt',
    rack.warnings.some((w) => /designs\[0\] \(CORNER\): The picture shows a shop rack of many different dupattas\. The result for CORNER is a best guess/.test(w))
    && /This reference is unclear \(The picture shows a shop rack/.test(rack.text), rack.warnings);
  // Measured: "problem" was added to required but not to properties; Gemini refused every
  // describe call with HTTP 400 and, since that step never fails a request, it went quiet.
  const undefinedRequired = (schema, path = 'schema') => {
    if (!schema || typeof schema !== 'object') return [];
    const own = (schema.required || []).filter((k) => !(schema.properties && k in schema.properties)).map((k) => `${path}.${k}`);
    const order = (schema.propertyOrdering || []).filter((k) => !(schema.properties && k in schema.properties)).map((k) => `${path}.ordering.${k}`);
    const kids = Object.entries(schema.properties || {}).flatMap(([k, v]) => undefinedRequired(v, `${path}.${k}`));
    return [...own, ...order, ...kids, ...(schema.items ? undefinedRequired(schema.items, `${path}[]`) : [])];
  };
  eq('every required or ordered field in the describe and inspection schemas is defined (Gemini refuses the call otherwise)',
    [...undefinedRequired(describe.RESPONSE_SCHEMA, 'describe'), ...undefinedRequired(qa.RESPONSE_SCHEMA, 'qa')], []);
  const onlyFirst = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ references: [{ ref: 1, motifs: 'mirror work', layout: 'band', colours: 'gold on red', technique: 'embroidery', notes: '', groundType: 'garment fabric', groundColour: 'red', problem: '' }] }) }] } }] };
  // The retry asks for the missing one alone; the model answers it with nothing.
  let posterCalls = 0;
  describe._setFetch(async (...args) => (++posterCalls === 1 ? describeAnswer(onlyFirst)(...args) : describeAnswer({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"references":[]}' }] } }] })(...args)));
  const refsPoster = referenceList(fakeJob('SHERWANI', ['COLLAR_NECK', 'HEM_BOTTOM']));
  const posterRead = await describe.describeReferences(refsPoster);
  const posterPrompt = buildPrompt(fakeJob('SHERWANI', ['COLLAR_NECK', 'HEM_BOTTOM']), { descriptions: posterRead });
  check('a reference the describe step answered around but left out is reported and kept simple (an Eid poster became a heavy paisley hem)',
    posterRead.declined.has(2) && posterPrompt.warnings.some((w) => /designs\[1\] \(HEM_BOTTOM\): The picture could not be read as a hem bottom design\. The result for HEM_BOTTOM is a best guess/.test(w))
    && /This reference is unclear \(The picture could not be read as a hem bottom design\)/.test(posterPrompt.text), posterPrompt.warnings);
  describe._setFetch(async () => { throw new Error('fetch failed'); });
  const lostRead = await describe.describeReferences(refsPoster);
  eq('a reference lost to a network error is not called unclear', [lostRead.declined.size, buildPrompt(fakeJob('SHERWANI', ['COLLAR_NECK', 'HEM_BOTTOM']), { descriptions: lostRead }).warnings.length], [0, 0]);
  describe._setFetch(describeAnswer(goodDescription));

  const plainFabric = [3, { motifs: '', colours: 'Solid bright red', technique: 'woven', groundType: 'not applicable', groundColour: 'bright red' }];
  const blouseRest = buildPrompt(fakeJob('BLOUSE', ['NECK', 'SLEEVE'], { fabrics: [{ image: IMG }] }), { descriptions: new Map([[1, { motifs: 'scalloped lace' }], [2, { motifs: 'leaves' }], plainFabric]) });
  const restCheck = qa.buildChecklist(blouseRest.review).find((c) => c.id === 'plain_rest');
  check('with a plain fabric, the rest of the garment is checked for borrowed motifs (teal flowers from a neck photo covered a red blouse)',
    !!restCheck && /only these parts carry a design: neckline of the blouse, sleeves of the blouse|only these parts carry a design: .*neck.*sleeve/i.test(restCheck.question), restCheck && restCheck.question);
  check('...but not with a patterned fabric, an OVERALL design, or no fabric reading',
    !qa.buildChecklist(buildPrompt(fakeJob('BLOUSE', ['NECK'], { fabrics: [{ image: IMG }] }), { descriptions: new Map([[1, { motifs: 'lace' }], [2, { motifs: 'woven jaal trellis', technique: 'jacquard' }]]) }).review).some((c) => c.id === 'plain_rest')
    && !qa.buildChecklist(buildPrompt(fakeJob('BLOUSE', ['OVERALL'], { fabrics: [{ image: IMG }] }), { descriptions: new Map([[1, { motifs: 'lace' }], [2, plainFabric[1]]]) }).review).some((c) => c.id === 'plain_rest')
    && !qa.buildChecklist(buildPrompt(fakeJob('BLOUSE', ['NECK'], { fabrics: [{ image: IMG }] })).review).some((c) => c.id === 'plain_rest'));
  // Round 6 (production, all 12 garments).
  const shararaTrim = buildPrompt(fakeJob('SHARARA', ['BORDER'], { fabrics: [{ image: IMG, color: 'pink', colorHex: '#E0307A' }] }), { descriptions: new Map([[1, { motifs: 'triangle lace', technique: 'gota lace', groundType: 'contrast panel', groundColour: 'aqua blue', garmentColour: 'turquoise' }]]) });
  check('a trim the same colour as the rest of its photographed garment is not a contrast panel (a pink sharara got aqua bands)',
    !shararaTrim.warnings.some((w) => /contrast panel/.test(w)) && /Ground colour for this part: pink, hex #E0307A/.test(shararaTrim.text), shararaTrim.warnings);
  check('...while a truly different panel colour still is',
    buildPrompt(fakeJob('SUIT', ['NECK'], { fabrics: [{ image: IMG, color: 'indigo' }] }), { descriptions: new Map([[1, { motifs: 'mirrors', groundType: 'contrast panel', groundColour: 'red', garmentColour: 'blue' }]]) }).warnings.some((w) => /NECK is a contrast panel/.test(w)));
  const zariSaree = buildPrompt(fakeJob('SAREE', ['BORDER', 'BODY'], { fabrics: [{ image: IMG, color: 'wine', colorHex: '#6D1A36' }] }), { descriptions: new Map([
    [1, { motifs: 'floral scrolls', colours: 'motifs: gold zari; background: mustard yellow', technique: 'woven zari brocade with metallic sheen', groundType: 'garment fabric' }],
    [2, { motifs: 'buttis', colours: 'background: mustard yellow', technique: 'thread embroidery', groundType: 'garment fabric' }]
  ]) });
  eq('a gold zari reference on mustard is not colour-checked as a leak (a correct wine saree was regenerated), a plain embroidery on mustard still is',
    qa.buildChecklist(zariSaree.review).filter((c) => c.id.startsWith('colour_')).map((c) => c.id), ['colour_body']);
  const noSleeve = (garment, areas) => /has NO sleeve design: its sleeves are plain fabric from shoulder to wrist/.test(buildPrompt(fakeJob(garment, areas)).text);
  eq('sleeves stay plain without a sleeve design (printed sleeves copied from a neck photo), only on garments that have sleeves',
    [noSleeve('ANARKALI', ['NECK']), noSleeve('SUIT', ['FRONT']), noSleeve('KURTHI', ['SLEEVE']), noSleeve('KURTHI', ['OVERALL']), noSleeve('SAREE', ['PALLU']), noSleeve('BLOUSE', ['HAND'])],
    [true, true, false, false, false, false]);
  check('a saree never gets tassels nobody sent (multi-coloured tassels appeared on a pallu), and a full-length photo keeps floor below the feet',
    /No tassels, latkans, pom-poms or fringe on the pallu end or anywhere on the saree/.test(buildPrompt(fakeJob('SAREE', ['PALLU'])).text)
    && /both feet stand on visible floor with a clear strip of floor below them/.test(buildPrompt(fakeJob('SAREE', ['PALLU'])).text));
  const anarkaliNeck = buildPrompt(fakeJob('ANARKALI', ['NECK']));
  check('without a sleeve design, the last words of the prompt and a dedicated check keep sleeves plain (printed sleeves survived a correction in production)',
    anarkaliNeck.text.indexOf('Final check on the sleeves of the Anarkali') > anarkaliNeck.text.indexOf('QUALITY BAR')
    && qa.buildChecklist(anarkaliNeck.review).some((c) => c.id === 'plain_sleeves')
    && !qa.buildChecklist(buildPrompt(fakeJob('ANARKALI', ['SLEEVE'])).review).some((c) => c.id === 'plain_sleeves'));
  check('with a plain fabric, the prompt ends by keeping everything outside the designed parts plain (a neck photo sequinned a whole sharara kurta)',
    blouseRest.text.indexOf('Final check on the rest of the blouse: only these parts carry a design - neck of the blouse, sleeve of the blouse') > blouseRest.text.indexOf('QUALITY BAR'), blouseRest.text.slice(blouseRest.text.indexOf('QUALITY BAR'), blouseRest.text.indexOf('QUALITY BAR') + 900));
  check('the print check judges only its own part (an embroidered ankle band failed a printed flare)',
    /Judge ONLY the flare of the bottom wear \(/.test((qa.buildChecklist(buildPrompt(fakeJob('BOTTOM_WEAR', ['FLARE', 'BOTTOM_ANKLE']), { descriptions: new Map([[1, { motifs: 'buttis', technique: 'Block print, matte' }]]) }).review).find((c) => c.id === 'print_flare') || {}).question || ''));
  check('a button is not colour-checked (amber gemstone buttons failed as "not ivory")',
    !qa.buildChecklist(buildPrompt(fakeJob('SHERWANI', ['BUTTON'], { fabrics: [{ image: IMG, color: 'ivory', colorHex: '#EDE3CC' }] }), { descriptions: new Map([[1, { motifs: 'gemstone', colours: 'background: dark blue', technique: 'metal button', groundType: 'garment fabric', groundColour: 'dark blue' }]]) }).review).some((c) => c.id === 'colour_button'));
  // Round 8: crop each design reference to its part (a neck photo sequinned a whole kurta through every rule).
  const cfgCrop = S('config').config.crop;
  const rect = crop.cropRect(crop.readBox([180, 340, 230, 410]), 1000, 1500);
  check('a tight box (a neckline alone) keeps at least 28% of each side, centred on it, so the part keeps its shoulders',
    rect && rect.width >= 280 && rect.height >= 420 && rect.left <= 340 && rect.left + rect.width >= 410 && rect.top <= 270 && rect.top + rect.height >= 345, JSON.stringify(rect));
  eq('a box that is most of the picture, a nonsense box and a 1%-wide box all mean: use the picture whole',
    [crop.cropRect(crop.readBox([0, 0, 900, 900]), 1000, 1000), crop.readBox([10, 20, 5]), crop.readBox([100, 100, 110, 800])], [null, null, null]);
  const cropJob = fakeJob('SHARARA', ['NECK', 'OVERALL']);
  const bigImage = { mimeType: 'image/png', base64: await png(800, 1200), original: { width: 800, height: 1200 } };
  cropJob.designs[0].image = { ...bigImage };
  cropJob.designs[1].image = { ...bigImage };
  let located = 0;
  crop._setFetch(async (...args) => { located++; return locateAnswer('part in a larger picture', [180, 340, 230, 410])(...args); });
  const boxes = await crop.locateParts(cropJob);
  const cropped = await crop.cropReferences(cropJob, boxes);
  const croppedMeta = await sharp(Buffer.from(cropJob.designs[0].image.base64, 'base64')).metadata();
  check('the neck photo is cropped to the neckline (and enlarged to a readable size); an OVERALL photo is never cropped or even located',
    located === 1 && cropped.length === 1 && cropped[0].area === 'NECK' && Math.min(croppedMeta.width, croppedMeta.height) >= cfgCrop.minSidePx
    && croppedMeta.width < croppedMeta.height * 1.5 && !cropJob.designs[1].image.cropped, JSON.stringify({ located, cropped, w: croppedMeta.width, h: croppedMeta.height }));
  check('the prompt says the picture was cropped and that what is cut off is not the design',
    /This picture has been cropped from a larger photograph to show the neck of the sharara set\. Anything cut off at its edges - the rest of that garment, its colour, its other decoration - is not part of this design/.test(buildPrompt(cropJob).text));
  crop._setFetch(locateAnswer('not visible'));
  const rackJob = fakeJob('DUPATTA', ['CORNER']);
  rackJob.designs[0].image = { ...bigImage };
  eq('a part that is not visible, a close-up, a failed call: no crop', [
    (await crop.cropReferences(rackJob, await crop.locateParts(rackJob))).length,
    (crop._setFetch(locateAnswer('close-up of the part')), (await crop.cropReferences(rackJob, await crop.locateParts(rackJob))).length),
    (crop._setFetch(async () => { throw new Error('fetch failed'); }), (await crop.cropReferences(rackJob, await crop.locateParts(rackJob))).length)
  ], [0, 0, 0]);
  crop._setFetch(locateAnswer('close-up of the part'));
  const normalRect = crop.cropRect(crop.readBox([180, 340, 230, 410]), 1000, 1500);
  const tightRect = crop.cropRect(crop.readBox([180, 340, 230, 410]), 1000, 1500, { tight: true });
  check('a retry after spread decoration gets a much tighter crop (a sequinned kurta kept coming back)',
    tightRect && tightRect.width * tightRect.height < normalRect.width * normalRect.height * 0.5, JSON.stringify({ normalRect, tightRect }));
  crop._setFetch(locateAnswer('part in a larger picture', [180, 340, 230, 410]));
  const tightJob = fakeJob('SHARARA', ['NECK']);
  tightJob.designs[0].image = { ...bigImage };
  const tightBoxes = await crop.locateParts(tightJob);
  const first = await crop.cropReferences(tightJob, tightBoxes);
  const second = await crop.cropReferences(tightJob, tightBoxes, { tight: true });
  check('...cut from the picture as sent, not from the first crop', first.length === 1 && second.length === 1 && second[0].from === '800x1200' && tightJob.designs[0].sourceImage === bigImage || (second[0] && second[0].from === '800x1200'), JSON.stringify({ first, second }));
  crop._setFetch(locateAnswer('close-up of the part'));
  eq('the part finder schema defines every field it requires', undefinedRequired(crop.LOCATE_SCHEMA, 'locate'), []);
  // Round 9: front and back photographs for two-sided garments; the design-library payload.
  const { viewOf, visibleIn } = S('promptBuilder');
  const libraryPayload = {
    garment_key: 'blouse', product_name: 'Blouse', notes: '', part_refs: {},
    parts: {
      back_design: { id: 'a', part: 'back_design', caption: '', sequence: 1, design_id: 'd1', image_url: cloud('ok.png'), part_label: 'Back Design', design_title: 'x', designer_name: '' },
      hand_design: { id: 'b', part: 'hand_design', caption: 'keep the tassels', sequence: 2, design_id: 'd2', image_url: cloud('ok.png'), part_label: 'Hand Design' },
      neck_design: { id: 'c', part: 'neck_design', caption: '', sequence: 4, design_id: 'd1', image_url: cloud('ok.png'), part_label: 'Neck Design' },
      front_design: { id: 'd', part: 'front_design', caption: '', sequence: 0, design_id: 'd1', image_url: cloud('ok.png'), part_label: 'Front Design' }
    },
    fabrics: { BORDER: [cloud('ok.png')], LINING: ['eeedba61-3b50-48ad-942b-a68a7d342f47'], MAIN_FABRIC: [cloud('ok.png')], BACKING_FABRIC: ['639c8187-eb4c-4287-a09e-eea363334a32'] },
    model_image: IMG, client_id: 'lib-1'
  };
  const libJob = resolveRequest(libraryPayload);
  eq('the design-library payload is accepted as sent: parts keyed by "<area>_design" in sequence order, fabrics by role, model_image',
    [libJob.garmentId, libJob.designs.map((d) => d.areaId), libJob.designs[2].note, libJob.designs[2].areaId, libJob.fabrics.map((f) => f.appliesTo || 'MAIN'), libJob.model.kind, libJob.productName, libJob.views],
    ['BLOUSE', ['FRONT', 'BACK', 'HAND', 'NECK'], 'keep the tassels', 'HAND', ['MAIN'], 'reference', 'Blouse', ['front', 'back']]);
  eq('lining, backing and a BORDER fabric on a garment with no border area are ignored; a main-fabric id instead of a picture is refused with the fix named',
    [libJob.fabrics.length + resolveRequest({ ...libraryPayload, garment_key: 'saree', parts: { pallu_design: { image_url: cloud('ok.png') } } }).fabrics.length, code(() => resolveRequest({ ...libraryPayload, fabrics: { MAIN_FABRIC: ['639c8187-eb4c-4287-a09e-eea363334a32'] } }))],
    [3, 'FABRIC_ID_NOT_IMAGE']);
  eq('views: a blouse gives both by default, can be limited to one, always front before back',
    [resolveRequest(body({ garment: 'BLOUSE', designs: [{ area: 'NECK', image: IMG }] })).views,
      resolveRequest(body({ garment: 'BLOUSE', designs: [{ area: 'NECK', image: IMG }], views: ['front'] })).views,
      resolveRequest(body({ garment: 'KURTHI', designs: [{ area: 'NECK', image: IMG }], views: ['back', 'front'] })).views],
    [['front', 'back'], ['front'], ['front', 'back']]);
  // Product decision, 10 Oct 2026: every garment is front and back by default.
  const sevenNew = [['SAREE', 'PALLU'], ['LEHANGA', 'SKIRT'], ['SHARARA', 'FLARE_PANTS'], ['GOWN', 'SKIRT_FLARE'], ['DUPATTA', 'BODY'], ['PETTICOAT', 'FLARE'], ['BOTTOM_WEAR', 'LEG']];
  eq('the seven garments that were front-only (saree, lehenga, sharara, gown, dupatta, petticoat, bottom wear) now give front and back by default',
    sevenNew.map(([garment, area]) => resolveRequest(body({ garment, designs: [{ area, image: IMG }] })).views.join('+')), sevenNew.map(() => 'front+back'));
  eq('...and any of them can still ask for one side',
    [resolveRequest(body({ views: ['back'] })).views, resolveRequest(body({ garment: 'GOWN', designs: [{ area: 'SKIRT_FLARE', image: IMG }], views: ['front'] })).views], [['back'], ['front']]);
  eq('every one of the 12 garments has both sides', Object.entries(S('garmentGuide').GUIDE).filter(([, g]) => g.sides.join('+') !== 'front+back').map(([id]) => id), []);
  eq('each view is shown only what it can display: FRONT, NECK, BUTTON, POCKET are front-only, BACK is back-only, sleeves/hems/borders/prints show in both',
    [['FRONT', 'NECK', 'BUTTON', 'BACK', 'SLEEVE', 'HAND', 'HEMLINE', 'PRINT', 'COLLAR_NECK'].map((a) => (visibleIn('front', a) ? 'F' : '-') + (visibleIn('back', a) ? 'B' : '-')).join(' ')],
    ['F- F- F- -B FB FB FB FB FB']);
  const twoSided = fakeJob('BLOUSE', ['FRONT', 'BACK', 'NECK', 'HAND'], { fabrics: [{ image: IMG, color: 'red', colorHex: '#C8102E' }] });
  const descAll = new Map([[1, { motifs: 'front flowers' }], [2, { motifs: 'back keyhole' }], [3, { motifs: 'neck lace' }], [4, { motifs: 'cuff tassels' }], [5, { motifs: '', colours: 'Solid red' }]]);
  const fv = viewOf(twoSided, descAll, 'front');
  const bv = viewOf(twoSided, descAll, 'back');
  eq('viewOf keeps each view\'s designs and renumbers the descriptions to match',
    [fv.job.designs.map((d) => d.areaId), [...fv.descriptions.entries()].map(([k, v]) => `${k}:${v.motifs || v.colours}`),
      bv.job.designs.map((d) => d.areaId), [...bv.descriptions.entries()].map(([k, v]) => `${k}:${v.motifs || v.colours}`)],
    [['FRONT', 'NECK', 'HAND'], ['1:front flowers', '2:neck lace', '3:cuff tassels', '4:Solid red'],
      ['BACK', 'HAND'], ['1:back keyhole', '2:cuff tassels', '3:Solid red']]);
  const frontPrompt = buildPrompt(fv.job, { descriptions: fv.descriptions, view: 'front' });
  const frontPhoto = { mimeType: 'image/jpeg', base64: FINAL_B64 };
  const backPrompt = buildPrompt(bv.job, { descriptions: bv.descriptions, view: 'back', frontPhoto });
  check('the front view faces the camera and says the back is photographed separately',
    frontPrompt.pose === 'front' && /photographed from the front/.test(frontPrompt.text) && /This is the FRONT view\. The back of the blouse is photographed separately/.test(frontPrompt.text)
    && !/back keyhole/.test(frontPrompt.text) && frontPrompt.parts.filter((p) => p.inlineData).length === 4, frontPrompt.text.slice(0, 200));
  check('the back view is made from the front photograph: it is sent as ground truth, the pose is back-to-camera looking over the shoulder, and no front design is shown',
    backPrompt.pose === 'back' && /photographed FROM THE BACK/.test(backPrompt.text) && /THE FRONT VIEW of this exact blouse, already photographed/.test(backPrompt.text)
    && /back squarely to the camera, head turned to look back over one shoulder/.test(backPrompt.text) && /hair is pinned up or brought forward/.test(backPrompt.text)
    && !/front flowers|neck lace/.test(backPrompt.text) && /back keyhole/.test(backPrompt.text)
    && backPrompt.parts.filter((p) => p.inlineData).length === 4 && backPrompt.review.view === 'back', backPrompt.text.slice(0, 200));
  check('a back view with no BACK design is plain, in the garment fabric',
    /No design reference was sent for the back of the blouse: its back is plain/.test(buildPrompt(viewOf(fakeJob('BLOUSE', ['NECK']), new Map(), 'back').job, { view: 'back' }).text));
  check('the old single-photo behaviour is unchanged for a saree (no view named)',
    buildPrompt(fakeJob('SAREE', ['PALLU'])).pose === 'front' && !/photographed from the front/.test(buildPrompt(fakeJob('SAREE', ['PALLU'])).text));
  eq('the pair check compares garment, sleeves, person, a true back view, studio and the supporting piece',
    qa.pairChecklist(backPrompt.review).map((c) => c.id), ['same_garment', 'same_sleeves', 'same_person', 'back_shown', 'no_front_on_back', 'same_studio', 'same_supporting', 'arms_clear', 'one_person']);
  const refs = [{ area: 'BACK', part: 'back of the blouse', ref: 1 }, { area: 'HAND', part: 'hand of the blouse', ref: 2 }];
  eq('every view is also checked against its own references: neckline shape/depth for a neckline, motifs and sheer panels for every part; the front view gets only those',
    [qa.viewChecklist(backPrompt.review, refs).map((c) => c.id).slice(0, 2), qa.viewChecklist(frontPrompt.review, [{ area: 'NECK', part: 'neck of the blouse', ref: 1 }]).map((c) => c.id),
      /SAME SHAPE, DEPTH and WIDTH/.test(qa.viewChecklist(backPrompt.review, refs)[0].question), /sheer or net area of that part still sheer/.test(qa.viewChecklist(backPrompt.review, refs)[1].question),
      /was sent ONLY for the hand of the blouse\. If it shows a whole garment, every other part of that garment \(its sleeves, body, neckline, hem, colour\) is NOT part of this reference/.test(qa.viewChecklist(backPrompt.review, refs)[1].question)],
    [['ref_back', 'ref_hand'], ['ref_neck', 'one_person'], true, true, true]);
  check('the prompt fixes neckline shape and depth, keeps sheer panels sheer, and keeps the arms at the sides in the back view',
    /fixes the neckline's exact SHAPE, DEPTH and WIDTH/.test(backPrompt.text) && /hands visible beside the hips - never clasped behind the back/.test(backPrompt.text)
    && /SHEER: part of this reference is sheer net/.test(buildPrompt(fakeJob('BLOUSE', ['NECK']), { descriptions: new Map([[1, { motifs: 'flowers', technique: 'embroidery on sheer net yoke', notes: 'round neck, shallow; SHEER yoke' }]]) }).text));
  check('the pair check judges cloth and cut, never the decoration (a real blouse with different front and back designs was called two blouses)',
    /Judge the CLOTH and CUT only - the front and the back carry their own, different designs on purpose/.test(qa.pairChecklist(backPrompt.review)[0].question));

  check('the describe step is asked for the problem and for the ground colour of every design',
    describe.readAnswer({ references: [{ ref: 1, motifs: 'x', problem: 'a collage' }] }, [{ ref: 1 }]).get(1).problem === 'a collage');

  check('a full-length photograph keeps the head and face in frame (bottom wear came out cropped at the chest)',
    /Nothing is cropped: the model's whole head and face are inside the frame/.test(buildPrompt(fakeJob('BOTTOM_WEAR', ['LEG'])).text));

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
  eq('framing per garment: blouse waist-up, everything else (dupatta included) full length',
    Object.fromEntries(taxonomy.GARMENT_IDS.map((id) => [id, GUIDE[id].framing])),
    { SAREE: 'full', BLOUSE: 'waist-up', DUPATTA: 'full', KURTHI: 'full', ANARKALI: 'full', PETTICOAT: 'full', GOWN: 'full', SUIT: 'full', SHERWANI: 'full', BOTTOM_WEAR: 'full', LEHANGA: 'full', SHARARA: 'full' });
  check('blouse: a waist-up photograph in which the blouse is never cropped, and not head to toe',
    blousePrompt.framing === 'waist-up' && /A waist-up portrait catalogue photograph in 3:4: the frame runs from a little above the head down to the upper thighs/.test(blousePair)
    && /The blouse itself is never cropped - all of it, including both sleeves and its full hem, is inside the frame/.test(blousePair)
    && !/head to toe/.test(blousePair) && !/fingers and feet/.test(blousePair));
  const dupattaPrompt = buildPrompt(fakeJob('DUPATTA', ['BORDER', 'TASSEL']));
  check('dupatta: full length, so its hanging ends and tassels are always in frame, with the head and face too',
    dupattaPrompt.framing === 'full' && /head to toe/.test(dupattaPrompt.text) && /the model's whole head and face are inside the frame/.test(dupattaPrompt.text));
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
  // Every job now has views, so FRONT and BACK designs each get their own photograph:
  // the old "one photograph cannot show both" warning would be false.
  const both = buildPrompt(fakeJob('KURTHI', ['FRONT', 'BACK']));
  eq('FRONT and BACK together on a job with views: no "one photograph" warning', both.warnings, []);
  const singlePhoto = buildPrompt({ ...fakeJob('KURTHI', ['BACK', 'NECK', 'PRINT']), views: null });
  check('only a job with no views at all (one photograph) still gets the honest warning naming NECK',
    singlePhoto.warnings.length === 1 && /leaves NECK partly or fully hidden/.test(singlePhoto.warnings[0]) && !/PRINT/.test(singlePhoto.warnings[0]),
    singlePhoto.warnings[0]);

  // The seven garments that gained a back view (10 Oct 2026): what their back photograph is told.
  const backOf = (garmentId, areas) => buildPrompt(viewOf(fakeJob(garmentId, areas), new Map(), 'back').job, { view: 'back' });
  const sareeBack = backOf('SAREE', ['PALLU', 'BORDER', 'PLEAT']);
  // Measured in the 10 Oct paid run: the pallu fell down the back whatever the prompt said,
  // so the back photograph is re-draped that way on purpose and says so.
  check('saree back: Nivi drape from behind, pleats not visible, the one pallu over the left shoulder and down the back, and the re-drape is stated',
    /seen from behind/.test(sareeBack.text) && /pleats are at the front of the body and are not visible from behind/.test(sareeBack.text)
      && /hangs straight down the back to about the knees/.test(sareeBack.text) && /It is the saree's only pallu/.test(sareeBack.text)
      && !/hangs down the front of the left side, fully open and facing the camera/.test(sareeBack.text)
      && /Only the viewpoint and the way the saree is draped change/.test(buildPrompt(viewOf(fakeJob('SAREE', ['PALLU']), new Map(), 'back').job, { view: 'back', frontPhoto: prepared }).text));
  eq('saree back: a PLEAT design is front-only; PALLU and BORDER still reach the back photograph',
    viewOf(fakeJob('SAREE', ['PALLU', 'BORDER', 'PLEAT']), new Map(), 'back').job.designs.map((d) => d.areaId), ['PALLU', 'BORDER']);
  check('saree back: borders and body continue round the back (not "the back is plain")',
    /continuing exactly as in the front photograph/.test(sareeBack.text) && !/its back is plain/.test(sareeBack.text));
  const dupattaBack = backOf('DUPATTA', ['BODY']).text;
  check('dupatta back: re-draped across the back with both ends down it, and the prompt says the drape changes on purpose',
    /draped differently: across the upper back and over both shoulders/.test(dupattaBack) && /Both decorated ends hang straight down the back/.test(dupattaBack)
      && /Only the viewpoint and the way the dupatta is draped change/.test(buildPrompt(viewOf(fakeJob('DUPATTA', ['BODY']), new Map(), 'back').job, { view: 'back', frontPhoto: prepared }).text));
  check('dupatta back: never told "no dupatta covers the back" or "shawl" (the dupatta IS the product there)',
    !/jewellery, a dupatta\) covers/.test(dupattaBack) && !/like a shawl/i.test(dupattaBack));
  check('...and the photo check does not count the dupatta itself as covering the back',
    !/a dupatta, a bag/.test(qa.viewChecklist({ view: 'back', product: 'dupatta', garmentId: 'DUPATTA' }).find((c) => c.id === 'back_shown').question)
      && /a dupatta, a bag/.test(qa.viewChecklist({ view: 'back', product: 'blouse', garmentId: 'BLOUSE' }).find((c) => c.id === 'back_shown').question));
  check('lehenga back: the dupatta falls down the left side, clear of the choli and skirt', /falls straight down the LEFT side of the body/.test(backOf('LEHANGA', ['SKIRT']).text));
  check('gown back with no BACK design: a plain back, as for a blouse (a gown has a back panel area)', /its back is plain/.test(backOf('GOWN', ['NECK']).text));
  // Measured in the 10 Oct paid run: a whole-gown BACK photo leaked its skirt leaves and a waistband onto the back.
  const gownBack = buildPrompt(viewOf(fakeJob('GOWN', ['BACK', 'SKIRT_FLARE']), new Map(), 'back').job, { view: 'back', frontPhoto: prepared }).text;
  check('gown and anarkali: a BACK design is the back of the bodice only, never the skirt or flare',
    /back of the gown's bodice, above the waist[\s\S]*does NOT decorate the skirt/.test(gownBack)
      && /back of the Anarkali's fitted bodice, above the waist seam[\s\S]*does NOT decorate the flare/.test(backOf('ANARKALI', ['BACK']).text));
  check('every back photo keeps the front photo\'s plain parts plain and adds no waistband or band the front lacks',
    /a plain skirt, flare or sleeve stays plain, and no waistband, belt, band or trim appears that this photograph does not show/.test(gownBack));
  check('...and says it again as the final check, the last word before the image is made (what fixed it in the paid run)',
    /Final check against the front view \[Image \d+\]: every part that shows in both photographs/.test(gownBack)
      && !/Final check against the front view/.test(buildPrompt(viewOf(fakeJob('GOWN', ['BACK']), new Map(), 'back').job, { view: 'back' }).text));

  // ── PRESENTATIONS (12 Oct 2026): model (default), mannequin, sketch ──
  section('DESIGN STUDIO: PRESENTATIONS  (model, mannequin, sketch)');
  const presentationOf = (over) => { try { return resolveRequest(body(over)).presentation; } catch (e) { return `${e.code}:${(e.details || [])[0] && e.details[0].field}`; } };
  eq('presentation: absent = model; values and the spellings callers type are understood; anything else is a 400 on the field',
    [presentationOf({}), presentationOf({ presentation: 'Mannequin' }), presentationOf({ presentation: 'maniquine' }), presentationOf({ presentation: 'dress-form' }),
      presentationOf({ presentation: 'SKETCH' }), presentationOf({ presentation: 'illustration' }), presentationOf({ presentation: 'robot' }), presentationOf({ presentation: 7 })],
    ['model', 'mannequin', 'mannequin', 'mannequin', 'sketch', 'sketch', 'VALIDATION_ERROR:presentation', 'VALIDATION_ERROR:presentation']);
  eq('a reference person (modelImage) only goes with model: 400 PRESENTATION_CONFLICT on modelImage otherwise',
    ['mannequin', 'sketch', 'model'].map((p) => { try { return resolveRequest(body({ presentation: p, modelImage: IMG })).model.kind; } catch (e) { return (e.details || [])[0].code; } }),
    ['PRESENTATION_CONFLICT', 'PRESENTATION_CONFLICT', 'reference']);
  const withPresentation = (garmentId, areas, presentation, extra = {}) => fakeJob(garmentId, areas, { ...extra, ...(presentation ? { presentation } : {}) });
  check('model prompts are the same with or without presentation: "model" (all 12 garments, front and back)',
    S('garmentGuide').taxonomy.GARMENT_IDS.every((gid) => {
      const area = S('garmentGuide').taxonomy.getDesignTypes(gid)[0].id;
      return ['front', 'back'].every((v) => buildPrompt(viewOf(withPresentation(gid, [area]), new Map(), v).job, { view: v, frontPhoto: v === 'back' ? prepared : null }).text
        === buildPrompt(viewOf(withPresentation(gid, [area], 'model'), new Map(), v).job, { view: v, frontPhoto: v === 'back' ? prepared : null }).text);
    }));

  const manFront = buildPrompt(viewOf(withPresentation('SAREE', ['PALLU']), new Map(), 'front').job, { view: 'front' });
  const manJob = withPresentation('SAREE', ['PALLU'], 'mannequin');
  const manF = buildPrompt(viewOf(manJob, new Map(), 'front').job, { view: 'front' });
  const manB = buildPrompt(viewOf(manJob, new Map(), 'back').job, { view: 'back', frontPhoto: prepared });
  check('mannequin: a headless dress form, no model section, no person anywhere; the garment sections are the same as for a model',
    /dressed on a headless dress-form mannequin/.test(manF.text) && /THE MANNEQUIN/.test(manF.text) && !/\nTHE MODEL\n/.test(manF.text)
      && /It has NO head, NO face, NO wig and NO hair/.test(manF.text) && /Exactly one mannequin and no person/.test(manF.text)
      && !/Exactly one person in the frame/.test(manF.text) && !/inset swatches, mannequin,/.test(manF.text)
      && manF.text.split('THE GARMENT')[1].split('WHAT THE')[0] === manFront.text.split('THE GARMENT')[1].split('WHAT THE')[0]);
  check('mannequin back: made from the front photo on "this same mannequin", the mannequin turned round, the saree back drape kept',
    /on this same mannequin/.test(manB.text) && /the mannequin \(the same dress form on the same stand\)/.test(manB.text)
      && /The mannequin is turned round so its back faces the camera squarely/.test(manB.text) && /hangs straight down the back to about the knees/.test(manB.text));
  eq('mannequin framing: a blouse on a bust form, a saree full length with the stand base',
    [/of a bust form, from just above its neck down to the hips/.test(buildPrompt(viewOf(withPresentation('BLOUSE', ['NECK'], 'mannequin'), new Map(), 'front').job, { view: 'front' }).text),
      /showing the whole mannequin, the whole saree and the base of the stand/.test(manF.text)], [true, true]);
  const manChecks = qa.viewChecklist(manB.review, [], { withFront: true }).map((c) => c.id);
  eq('mannequin photo checks: "no person" added, "same mannequin" instead of "same person", no "arms at the sides"',
    [manChecks.includes('no_person'), manChecks.includes('same_mannequin'), manChecks.includes('same_person'), manChecks.includes('arms_clear'),
      qa.viewChecklist(manF.review, []).map((c) => c.id)], [true, true, false, false, ['no_person']]);

  const sketchDesc = new Map([[1, { motifs: 'large gold zari paisleys, with vines', technique: 'woven zari' }], [2, { motifs: 'peacocks and temple motifs' }]]);
  const sketchJob = withPresentation('SAREE', ['PALLU', 'BORDER', 'PLEAT'], 'sketch', { fabrics: [{ image: IMG, name: 'Banarasi silk', color: 'teal' }] });
  for (const f of sketchJob.fabrics) f.image = prepared;
  const sk = buildPrompt(sketchJob, { descriptions: sketchDesc });
  check('sketch: one hand-drawn sheet, front and back figures side by side, watercolour on paper, no photo rules',
    /Create one fashion design presentation sheet: a hand-drawn illustration of a brand-new saree, shown from the FRONT and from the BACK side by side/.test(sk.text)
      && /THE FIGURES/.test(sk.text) && /on the LEFT, the FRONT view/.test(sk.text) && /THE ILLUSTRATION/.test(sk.text) && /soft watercolour washes with fine, confident ink outlines/.test(sk.text)
      && /Not a photograph and not a 3D render/.test(sk.text) && !/\nTHE PHOTOGRAPH\n/.test(sk.text) && !/Photorealistic/.test(sk.text) && /Return only the finished illustration sheet/.test(sk.text));
  check('sketch: the back figure follows the back drape (saree pallu down the back), said as "the back figure"',
    /In the BACK figure of the sheet:[\s\S]*For the back figure the pallu is draped the classic way/.test(sk.text));
  eq('sketch labels come from the order and the reading of the references: area, short description, fabric, worn with',
    sk.annotations.map((a) => [a.label, a.on.join('+')]),
    [['Pallu: large gold zari paisleys', 'front+back'], ['Border: peacocks and temple motifs', 'front+back'], ['Pleat', 'front'], ['Fabric: teal Banarasi silk', 'front+back'], ['Worn with: plain blouse', 'front']]);
  check('...and every label is written into the prompt word for word, with what it points to',
    sk.annotations.every((a) => sk.text.includes(`- "${a.label}" - pointing to ${a.pointsTo}`)) && /Spell every word exactly as written above/.test(sk.text));
  check('sketch is not judged by the photograph checks (review is null)', sk.review === null);
  const longLabels = buildPrompt(withPresentation('GOWN', ['SKIRT_FLARE', 'BACK', 'NECK', 'SLEEVE', 'WAIST', 'BORDER_HEM'], 'sketch'),
    { descriptions: new Map([[1, { motifs: 'Très élégant (hand-worked) zardozi florals with very long trailing stems' }]]) }).annotations;
  check('labels: at most 8, at most 40 characters, plain ASCII, no bracketed asides',
    longLabels.length <= 8 && longLabels.every((a) => a.label.length <= 40 && /^[\x20-\x7E]+$/.test(a.label) && !/\(/.test(a.label)), JSON.stringify(longLabels.map((a) => a.label)));
  const frontOnlySheet = buildPrompt(withPresentation('GOWN', ['BACK', 'NECK'], 'sketch', { views: ['front'] }));
  eq('a front-only sheet: one figure; the BACK design has nowhere to point, so it gets no label',
    [/One full-length figure/.test(frontOnlySheet.text), frontOnlySheet.annotations.map((a) => a.part)], [true, ['NECK']]);
  // Measured in the 12 Oct paid run, and fixed:
  check('sketch: each label written once (it was drawn beside both figures), one FRONT and one BACK caption allowed',
    /written ONCE, beside whichever figure shows it best/.test(sk.text) && !/on either figure/.test(sk.text) && /Each label appears exactly once on the sheet/.test(sk.text)
      && /one small caption: "FRONT" under the front figure and "BACK" under the back figure, once each/.test(sk.text)
      && /No other text of any kind: no caption, title/.test(frontOnlySheet.text));
  check('sketch: a final check that both figures show the same skirt, hem and sleeves (a gown sheet\'s back leaves spread onto the skirt)',
    /Final check between the two figures: every part that shows on both/.test(sk.text) && !/Final check between the two figures/.test(frontOnlySheet.text));
  eq('labels never end on a joining word ("small geometric shapes in a")',
    buildPrompt(withPresentation('ANARKALI', ['BACK'], 'sketch'), { descriptions: new Map([[1, { motifs: 'small geometric shapes in a lattice, red' }]]) }).annotations.map((a) => a.label),
    ['Back: small geometric shapes', 'Worn with: plain churidar']);
  eq('labels are cut at a phrase break, never mid-phrase (both measured in the 12 Oct paid run), and read in lower case after the colon',
    [buildPrompt(withPresentation('SAREE', ['BORDER'], 'sketch'), { descriptions: new Map([[1, { motifs: 'Large peacock motifs facing each other in pairs' }]]) }).annotations[0].label,
      buildPrompt(withPresentation('GOWN', ['BACK'], 'sketch'), { descriptions: new Map([[1, { motifs: 'large stylized leaves with central veins' }]]) }).annotations[0].label,
      buildPrompt(withPresentation('SAREE', ['PALLU'], 'sketch'), { descriptions: new Map([[1, { motifs: 'paisley and floral butis' }]]) }).annotations[0].label],
    ['Border: large peacock motifs', 'Back: large stylized leaves', 'Pallu: paisley and floral butis']);
  eq('a lone leading adjective is skipped and "made from" ends the phrase (both measured on a real 7-part saree, 13 Oct)',
    [buildPrompt(withPresentation('SAREE', ['PRINT'], 'sketch'), { descriptions: new Map([[1, { motifs: 'Small, intricate floral motifs and leaves forming a dense jaal' }]]) }).annotations[0].label,
      buildPrompt(withPresentation('SAREE', ['BODY'], 'sketch'), { descriptions: new Map([[1, { motifs: 'Small flower shapes made from silver sequins with a central cream pearl' }]]) }).annotations[0].label,
      buildPrompt(withPresentation('SAREE', ['BODY'], 'sketch'), { descriptions: new Map([[1, { motifs: 'Small round pearls and tiny silver sequins scattered' }]]) }).annotations[0].label,
      buildPrompt(withPresentation('SAREE', ['PRINT'], 'sketch'), { descriptions: new Map([[1, { motifs: 'intricate floral motifs and leaves' }]]) }).annotations[0].label],
    ['Print: intricate floral motifs', 'Body: small flower shapes', 'Body: small round pearls', 'Print: intricate floral motifs']);
  // Every saree part has its own design: print, embroidery and zari work must still be used (13 Oct, boutique rule).
  const allSaree = ['PALLU', 'BORDER', 'BODY', 'PLEAT', 'PRINT', 'EMBROIDERY', 'ZARI_WORK'];
  const crowdedModel = buildPrompt(fakeJob('SAREE', allSaree));
  const crowdedSketch = buildPrompt(withPresentation('SAREE', allSaree, 'sketch'), { descriptions: new Map() });
  check('every part designed: embroidery and zari work are added on top (stones, pearls), the print becomes the body ground, and none may be left out',
    /DESIGN for EMBROIDERY[^\n]*\nGoes on: every part of the saree already has its own design, so this work is ADDED ON TOP[^\n]*stones, pearls, sequins/.test(crowdedModel.text)
      && /DESIGN for ZARI_WORK[^\n]*\nGoes on: [^\n]*ADDED ON TOP/.test(crowdedModel.text)
      && /DESIGN for PRINT[^\n]*\nGoes on: [^\n]*becomes the GROUND of the main body/.test(crowdedModel.text)
      && /EVERY design reference must appear in the finished garment - none may be left out/.test(crowdedModel.text)
      && !/apply everywhere else/.test(crowdedModel.text));
  check('the sheet says how many labels it has (a "Worn with" label was written twice, 13 Oct)',
    new RegExp(`exactly ${crowdedSketch.annotations.length} labels in total, no more`).test(crowdedSketch.text) && crowdedSketch.annotations.length === 8);
  eq('...and the sketch labels point at where that layered work is',
    crowdedSketch.annotations.filter((a) => ['PRINT', 'EMBROIDERY', 'ZARI_WORK'].includes(a.part)).map((a) => a.pointsTo),
    ['the printed ground pattern of the saree\'s body, between its motifs', 'the stone and pearl embroidery along the border edge of the saree', 'the zari and stone work along the border edge of the saree']);
  check('a part left free: the whole-garment design still goes "everywhere else", unchanged',
    /apply everywhere else/.test(buildPrompt(fakeJob('SAREE', ['PALLU', 'BORDER', 'EMBROIDERY'])).text) && !/ADDED ON TOP/.test(buildPrompt(fakeJob('SAREE', ['PALLU', 'BORDER', 'EMBROIDERY'])).text));
  // 15 Oct, through the test page: the pallu and border failed the check for pearls layered on purpose.
  const layeredRefs = [{ area: 'PALLU', part: 'pallu of the saree', ref: 1 }, { area: 'EMBROIDERY', part: 'embroidery of the saree', ref: 6 }];
  const onPurpose = /come from the separate EMBROIDERY and ZARI_WORK references and are added on purpose - ignore them here/;
  eq('every part designed: a part\'s check ignores the stone work layered on it on purpose; the embroidery\'s own check and a normal request do not',
    [onPurpose.test(qa.viewChecklist(crowdedModel.review, layeredRefs)[0].question), onPurpose.test(qa.viewChecklist(crowdedModel.review, layeredRefs)[1].question),
      onPurpose.test(qa.viewChecklist(buildPrompt(fakeJob('SAREE', ['PALLU', 'BORDER', 'EMBROIDERY'])).review, layeredRefs)[0].question)],
    [true, false, false]);
  check('mannequin: hanging parts fall straight down (a saree pallu stuck out sideways in mid-air), never fanned out to the side',
    /Nothing floats or is held out in the air: every hanging part \(a pallu, a dupatta, its ends\) is pinned in place and falls straight down/.test(manF.text)
      && /never fanned or spread out to the side/.test(manF.text));

  // A sketch's BACK design is cropped to that part even with cropping switched off (12 Oct 2026:
  // a whole-gown BACK picture spread its leaves onto the back of a sketched skirt).
  const cropWasOn = cfgCrop.enabled;
  cfgCrop.enabled = false;
  try {
    const located = [];
    crop._setFetch(async (url, opts) => {
      const asked = JSON.parse(opts.body).contents[0].parts.filter((p) => p.text).map((p) => p.text).join('\n');
      located.push((asked.match(/design for the ([a-z ]+) of/) || [])[1]);
      return locateAnswer('part in a larger picture', [100, 200, 450, 800])();
    });
    const gownSheet = withPresentation('GOWN', ['BACK', 'NECK', 'SKIRT_FLARE'], 'sketch');
    const realPicture = { mimeType: 'image/png', base64: await png(900, 1200), original: { width: 900, height: 1200 }, sent: { width: 900, height: 1200, bytes: 1 } };
    for (const d of gownSheet.designs) d.image = { ...realPicture };
    const boxes = await crop.locateParts(gownSheet, { only: ['BACK'] });
    const cropped = await crop.cropReferences(gownSheet, boxes, { only: ['BACK'] });
    eq('with cropping off, only the BACK design is located and cropped (one small call); the others go whole',
      [located, cropped.map((c) => c.area), gownSheet.designs.map((d) => !!d.image.cropped)], [['back'], ['BACK'], [true, false, false]]);
    located.length = 0;
    eq('...and without "only", cropping off means no crop calls at all (model and mannequin requests)',
      [(await crop.locateParts(withPresentation('GOWN', ['BACK'], 'model'))).size, located.length], [0, 0]);
  } finally {
    cfgCrop.enabled = cropWasOn;
    crop._setFetch(locateAnswer('close-up of the part'));
  }
  check('the saree front photograph keeps the front drape',
    /hangs down the front of the left side, fully open and facing the camera/.test(buildPrompt(viewOf(fakeJob('SAREE', ['PALLU']), new Map(), 'front').job, { view: 'front' }).text));
  eq('a BACK design on its own needs no warning', buildPrompt(fakeJob('KURTHI', ['BACK'])).warnings, []);
  const ref = buildPrompt(fakeJob('SAREE', ['PALLU'], { modelImage: IMG }));
  check('a model photo is a try-on: drawn into their own photo - their room, pose, hands, framing and light kept - under the Try-On identity lock',
    /^TASK\nEdit the PERSON PHOTO: dress this exact real person in a brand-new saree/.test(ref.text) && /This is a virtual try-on: the garment is draped onto them in their own photo/.test(ref.text)
      && /IDENTITY LOCK - HIGHEST PRIORITY/.test(ref.text) && /face is forensic evidence/.test(ref.text) && /no lightening, no darkening, no evening out/.test(ref.text) && /\(bindi, nose pin, earrings\)/.test(ref.text)
      && /Keep their exact pose/.test(ref.text) && /The PERSON PHOTO is the scene/.test(ref.text) && /Add nothing to the scene: no new shadows, light patterns/.test(ref.text) && !/seamless, plain studio backdrop/.test(ref.text) && !/Pose: standing tall/.test(ref.text)
      && !/Nothing \(hair, hands, jewellery or other clothing\) may cover/.test(ref.text));
  const firstImage = ref.parts.findIndex((p) => p.inlineData);
  eq('a model photo is the FIRST image the image model sees, unnumbered; the design is still [Image 1]',
    [/^PERSON PHOTO: the real person to dress/.test(ref.parts[firstImage - 1].text), /\[Image 1\] DESIGN for PALLU/.test(ref.text), /\[Image 2\]/.test(ref.text)], [true, true, false]);
  check('a model photo without a gender is not assumed to be a woman', !/\bwoman\b|\bher\b/.test(ref.text.split('THE PHOTOGRAPH')[0]));
  const refFront = buildPrompt(viewOf(fakeJob('SAREE', ['PALLU'], { modelImage: IMG }), new Map(), 'front').job, { view: 'front' });
  const refBack = buildPrompt(viewOf(fakeJob('SAREE', ['PALLU'], { modelImage: IMG }), new Map(), 'back').job, { view: 'back', frontPhoto: prepared });
  eq('a model photo: the face is checked against it on the front view only (from behind it is barely seen); a generated model has no face check, only the one-person check',
    [qa.viewChecklist(refFront.review, []).map((c) => c.id), qa.viewChecklist(refBack.review, [], { withFront: true }).some((c) => c.id === 'same_face'),
      qa.viewChecklist(buildPrompt(viewOf(fakeJob('SAREE', ['PALLU']), new Map(), 'front').job, { view: 'front' }).review, []).map((c) => c.id)], [['same_face', 'one_person'], false, ['one_person']]);
  check('a model photo, back view: the same room and light as the front photo, turned round there - not their original pose, not a studio',
    /The same room, background, light and framing as the front view photograph \[Image 2\], with the person turned round in the same spot/.test(refBack.text)
      && /Pose: standing full length with the back squarely to the camera/.test(refBack.text) && !/Keep their exact pose/.test(refBack.text) && !/seamless, plain studio backdrop/.test(refBack.text)
      && /their own hair, in its own style, is brought forward over one shoulder - never put up in a bun/.test(refBack.text) && !/hair is pinned up/.test(refBack.text));
  check('a model photo, back view: the face is not shown at all (looking over the shoulder drew a new face, 13 Oct), and that is checked',
    /the head facing straight ahead, away from the camera: only the back of the head and hair are seen - no face, no profile/.test(refBack.text) && !/look back over one shoulder/.test(refBack.text)
      && qa.viewChecklist(refBack.review, [], { withFront: true }).some((c) => c.id === 'face_hidden')
      && /head turned to look back over one shoulder so the face is recognisable/.test(buildPrompt(viewOf(fakeJob('SAREE', ['PALLU']), new Map(), 'back').job, { view: 'back', frontPhoto: prepared }).text)
      && !qa.viewChecklist(buildPrompt(viewOf(fakeJob('SAREE', ['PALLU']), new Map(), 'back').job, { view: 'back', frontPhoto: prepared }).review, [], { withFront: true }).some((c) => c.id === 'face_hidden'));
  // The sketch label check compares what the reader saw with the given labels (13 Oct, real slips).
  const given = ['Pallu: large geometric shapes', 'Embroidery: round pearls', 'Pleat: all-over floral and leaf patterns', 'Worn with: plain blouse'];
  eq('sketch labels: a repeated label, two labels merged into one, and a dropped word are each caught; FRONT/BACK and a reader\'s one-letter slip are not',
    [qa.labelFailures(given, ['Pallu: large geometric shapes', 'PALLU: large geometric shapes', 'Zari / Embroidery: round pearls', 'Pleat: all-over floral and patterns', 'Worn with: plain blouse', 'FRONT', 'BACK']).map((f) => f.id),
      qa.labelFailures(given, ['Pallu: large geometric shapes', 'Embroidery: round pearl', 'Pleat: all-over floral and leaf patterns', 'Worn with: plain blouse', 'FRONT', 'BACK'])],
    [['label_repeated', 'label_missing', 'label_missing', 'label_extra', 'label_extra'], []]);
  eq('sketch labels: two labels 3 letters apart ("Pleat:..." / "Print:...") are each counted once, not twice (a false redo, 13 Oct)',
    qa.labelFailures(['Pleat: small floral and leaf motifs', 'Print: small floral and leaf motifs'], ['Pleat: small floral and leaf motifs', 'Print: small floral and leaf motifs', 'FRONT']), []);
  check('sherwani: a woman (a womens sherwani-style jacket), her mid-twenties', /a woman in her mid-twenties/.test(buildPrompt(fakeJob('SHERWANI', ['BUTTON'])).text) && /Tailor it sharply to a woman's figure/.test(buildPrompt(fakeJob('SHERWANI', ['BUTTON'])).text));
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
  // Google's ordinary per-minute limit says "check your plan and billing details"
  // too. Reading "billing" as "budget spent" stopped retrying a limit that clears in seconds.
  const perMinute = JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }] }] } });
  calls = script([() => new Response(perMinute, { status: 429 }), () => answer([imagePart(FINAL)])]);
  out = await run();
  eq('the per-minute 429 that mentions "billing details" is retried, not reported as quota spent', [!!out.image, calls.length], [true, 2]);
  const perDay = JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }] }] } });
  calls = script([() => new Response(perDay, { status: 429 })]);
  out = await run();
  eq('a spent DAILY quota is reported at once as MODEL_QUOTA_EXCEEDED', [out.error.code, calls.length], ['MODEL_QUOTA_EXCEEDED', 1]);
  calls = script([() => new Response(JSON.stringify({ error: { code: 503, message: 'The model is overloaded. Please try again later.' } }), { status: 503 })]);
  out = await run();
  eq('still unavailable after retries: the caller gets our sentence, not Google\'s body',
    [out.error.code, out.error.message], ['MODEL_UNAVAILABLE', 'The image model is unavailable right now. Please retry shortly.']);
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
  check('...and Google\'s own wording stays out of the caller\'s message', !/invalid argument/i.test(out.error.message), out.error.message);
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
  // And the inspector: passes every check unless told which ids to fail.
  const qaAnswer = (failIds = []) => async (url, opts) => {
    const request = JSON.parse(opts.body);
    const ids = [...request.contents[0].parts[0].text.matchAll(/^- ([a-z_]+):/gm)].map((m) => m[1]);
    const checks = ids.map((id) => ({ id, pass: !failIds.includes(id), evidence: failIds.includes(id) ? 'thin gold band at both sleeve ends' : 'ok' }));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ checks }) }] } }] }), { status: 200 });
  };
  const qaSequence = (...answers) => { let n = 0; return (url, opts) => answers[Math.min(n++, answers.length - 1)](url, opts); };
  qa._setFetch(qaAnswer());
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
  // These tests are about the stream itself, so they ask for one photograph; the
  // front-and-back default has tests of its own below.
  const oneView = (over = {}) => body({ views: ['front'], ...over });
  const readEvents = async (res) => {
    const text = await res.text();
    return { text, events: text.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6))) };
  };

  try {
    const opt = await (await fetch(base + '/options')).json();
    eq('GET /options lists 12 garments with their areas, limits and 3:4', [opt.garments.length, opt.garments.find((g) => g.id === 'SAREE').designAreas.length, opt.limits.maxDesigns, opt.model.aspectRatio, opt.garments.find((g) => g.id === 'SHERWANI').defaultModelGender],
      [12, 8, 8, '3:4', 'female']);
    eq('GET /options says every garment gives a front and a back view',
      opt.garments.filter((g) => g.views.join('+') !== 'front+back').map((g) => g.id), []);
    eq('GET /options says what each product is worn with, and the default colour',
      [opt.garments.find((g) => g.id === 'SAREE').pairedWith, opt.garments.find((g) => g.id === 'BLOUSE').pairedWith.pieces, opt.garments.find((g) => g.id === 'GOWN').pairedWith],
      [{ pieces: 'blouse', defaultColour: 'matches the main fabric' }, 'skirt', null]);
    eq('GET /options says how each garment is framed',
      ['SAREE', 'BLOUSE', 'DUPATTA'].map((id) => opt.garments.find((g) => g.id === id).framing), ['full', 'waist-up', 'full']);

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
      clientId: 'shop-1', garment: 'saree', views: ['front'],
      designs: [{ area: 'PALLU', image: IMG }, { area: 'BORDER', image: cloud('ok.png'), note: 'keep the peacocks' }],
      fabrics: [{ image: IMG, name: 'Banarasi silk' }]
    });
    eq('a good request opens an event stream', [res.status, res.headers.get('content-type')], [200, 'text/event-stream; charset=utf-8']);
    let { events } = await readEvents(res);
    eq('events: start, reading references, brief, generating (the view), generating, retry, inspection, reference check, image, done',
      [events.map((e) => e.type), events.filter((e) => e.type === 'status').map((e) => e.stage)],
      [['start', 'status', 'brief', 'status', 'status', 'status', 'status', 'status', 'image', 'done'], ['reading-references', 'generating', 'generating', 'generating', 'checking', 'checking']]);
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
    ({ events } = await readEvents(await post('/generate', oneView({ clientId: 'no-brief' }))));
    eq('if the describe step fails there is no brief, and the image still arrives',
      [events.map((e) => e.type), events.some((e) => e.type === 'brief')], [['start', 'status', 'status', 'status', 'status', 'status', 'image', 'done'], false]);
    describe._setFetch(describeAnswer(goodDescription));

    // A refusal inside the stream.
    script([() => answer([], { promptFeedback: { blockReason: 'SAFETY' } })]);
    ({ events } = await readEvents(await post('/generate', oneView())));
    eq('a refusal arrives as an error event and the stream ends, no image', [events.map((e) => e.type), events[events.length - 1].code], [['start', 'status', 'brief', 'status', 'status', 'error'], 'GENERATION_BLOCKED']);

    // The default a caller gets: the photograph only, no text about how it was made.
    const streamCfg = S('config').config.stream;
    streamCfg.detail = 'image';
    script([() => answer([imagePart(FINAL)])]);
    ({ events } = await readEvents(await post('/generate', oneView({ clientId: 'image-only' }))));
    eq('by default the stream carries only start (jobId), the image and done - no brief, warnings, status text, quality or timings',
      events.map((e) => [e.type, Object.keys(e).sort().join(',')]),
      [['start', 'jobId,type'], ['image', 'height,image,jobId,mimeType,type,view,width'], ['done', 'jobId,status,type,views']]);
    check('...and the image is still the full photograph', /^data:image\/jpeg;base64,\/9j\//.test(events[1].image));
    script([() => answer([], { promptFeedback: { blockReason: 'SAFETY' } })]);
    ({ events } = await readEvents(await post('/generate', oneView({ clientId: 'image-only-2' }))));
    eq('...and an error keeps its code, message, retryable flag and the documented details',
      events.map((e) => [e.type, Object.keys(e).sort().join(',')]), [['start', 'jobId,type'], ['error', 'code,details,jobId,message,retryable,type']]);
    eq('...GENERATION_BLOCKED carries details.reason, as the docs promise', [events[1].code, events[1].details], ['GENERATION_BLOCKED', { reason: 'SAFETY' }]);
    streamCfg.detail = 'full';

    // Two photographs for a two-sided garment: front, then back made from the front.
    script([() => answer([imagePart(FINAL)])]);
    const twoCalls = script([() => answer([imagePart(FINAL)])]);
    ({ events } = await readEvents(await post('/generate', { clientId: 'two-view', garment: 'BLOUSE', designs: [{ area: 'FRONT', image: IMG }, { area: 'BACK', image: IMG }, { area: 'HAND', image: IMG }], fabrics: [{ image: IMG, color: 'red' }] })));
    const imgs = events.filter((e) => e.type === 'image');
    const doneTwo = events[events.length - 1];
    eq('a blouse streams a front image and then a back image, and done lists both views',
      [events[0].views, imgs.map((e) => e.view), doneTwo.views, doneTwo.status, typeof doneTwo.quality.front, typeof doneTwo.quality.back],
      [['front', 'back'], ['front', 'back'], ['front', 'back'], 'ok', 'object', 'object']);
    const imagesIn = (call) => call.body.contents[0].parts.filter((p) => p.inlineData).length;
    const textOf = (call) => call.body.contents[0].parts.filter((p) => p.text).map((p) => p.text).join('\n');
    eq('the image model was called twice: the front with front+hand+fabric, the back with back+hand+fabric+the finished front photograph',
      [twoCalls.length, imagesIn(twoCalls[0]), imagesIn(twoCalls[1]), /THE FRONT VIEW of this exact blouse/.test(textOf(twoCalls[1])), /THE FRONT VIEW/.test(textOf(twoCalls[0]))],
      [2, 3, 4, true, false]);
    check('the pair check was run on the two photographs (front then back) and passed',
      doneTwo.quality.back.pair && doneTwo.quality.back.pair.checked === true && doneTwo.quality.back.pair.passed === true, JSON.stringify(doneTwo.quality.back));

    // The pair check finds a difference: the back is made once more with it named.
    // Fail same_sleeves the first time it is asked, whatever else is checked before it.
    let sleevesFailed = false;
    qa._setFetch(async (url, opts) => {
      const ids = [...JSON.parse(opts.body).contents[0].parts[0].text.matchAll(/^- ([a-z_]+):/gm)].map((m) => m[1]);
      if (!sleevesFailed && ids.includes('same_sleeves')) { sleevesFailed = true; return qaAnswer(['same_sleeves'])(url, opts); }
      return qaAnswer()(url, opts);
    });
    const pairCalls = script([() => answer([imagePart(FINAL)])]);
    ({ events } = await readEvents(await post('/generate', { clientId: 'two-view-2', garment: 'KURTHI', designs: [{ area: 'BACK', image: IMG }], views: ['front', 'back'] })));
    const donePair = events[events.length - 1];
    eq('a back view that differs from the front is regenerated with the difference named, then passes',
      [pairCalls.length, donePair.quality.back.regenerated, donePair.quality.back.pair.passed, /CORRECTIONS - IMPORTANT[\s\S]*The sleeves are identical to the front view/.test(textOf(pairCalls[2]))],
      [3, true, true, true]);
    qa._setFetch(qaAnswer());

    // One view only, on request; and the image-only stream carries the view.
    streamCfg.detail = 'image';
    script([() => answer([imagePart(FINAL)])]);
    ({ events } = await readEvents(await post('/generate', { clientId: 'one-view', garment: 'BLOUSE', designs: [{ area: 'NECK', image: IMG }], views: ['front'] })));
    eq('views: ["front"] gives one photograph, and the image-only stream labels it',
      events.map((e) => [e.type, e.view || e.views || '']), [['start', ''], ['image', 'front'], ['done', ['front']]]);
    streamCfg.detail = 'full';

    // views: ["back"] alone: no front photograph exists to compare with, so the
    // front-versus-back checks must not be asked (a wrong failure buys a paid regeneration).
    const askedIds = [];
    qa._setFetch(async (url, opts) => {
      askedIds.push(...[...JSON.parse(opts.body).contents[0].parts[0].text.matchAll(/^- ([a-z_]+):/gm)].map((m) => m[1]));
      return qaAnswer()(url, opts);
    });
    script([() => answer([imagePart(FINAL)])]);
    ({ events } = await readEvents(await post('/generate', { clientId: 'back-only', garment: 'BLOUSE', designs: [{ area: 'BACK', image: IMG }], views: ['back'] })));
    eq('views: ["back"] alone: one back photograph, and no check compares it with a front that does not exist',
      [events.filter((e) => e.type === 'image').map((e) => e.view), askedIds.some((id) => ['same_person', 'same_sleeves', 'same_garment', 'same_studio'].includes(id)), askedIds.includes('back_shown')],
      [['back'], false, true]);
    qa._setFetch(qaAnswer());

    // The caller's own photo: a changed face is caught by the reference check and made again.
    const faceAsks = [];
    let faceRound = 0;
    qa._setFetch(async (url, opts) => {
      const parts = JSON.parse(opts.body).contents[0].parts;
      faceAsks.push({ ids: [...parts[0].text.matchAll(/^- ([a-z_]+):/gm)].map((m) => m[1]), person: parts.some((p, i) => p.text === 'PERSON photo:' && parts[i + 1] && parts[i + 1].inlineData) });
      // Fail the face check the first time it is asked (the inspection may be asked first).
      const asked = faceAsks[faceAsks.length - 1].ids.includes('same_face');
      return qaAnswer(asked && faceRound++ === 0 ? ['same_face'] : [])(url, opts);
    });
    const faceCalls = script([() => answer([imagePart(FINAL)])]);
    // A narrow photo, like the real one (379x1172) that was widened and redrawn on 19 Oct.
    const NARROW = await png(400, 1200, '#557755');
    ({ events } = await readEvents(await post('/generate', { clientId: 'own-photo', garment: 'SAREE', modelImage: NARROW, designs: [{ area: 'PALLU', image: IMG }], views: ['front'] })));
    // Since 19 Oct an own photo is made in two steps: the garment on a mannequin, then draped onto the photo.
    const drapeCallParts = faceCalls[1] && faceCalls[1].body.contents[0].parts;
    eq('own photo, two steps: the garment on a mannequin (normal size, 3:4), then draped onto the photo the Try-On way - the photo last, in its own shape, at the larger size',
      [faceCalls.length, /headless dress-form mannequin/.test(textOf(faceCalls[0])), faceCalls[0].body.generationConfig.imageConfig.imageSize, faceCalls[0].body.generationConfig.imageConfig.aspectRatio,
        /virtual fitting session/.test(textOf(faceCalls[1])) && /RULE #1 - ABSOLUTE IDENTITY LOCK/.test(textOf(faceCalls[1])) && /RULE #3 - THE SCENE LOCK/.test(textOf(faceCalls[1])),
        !!drapeCallParts[drapeCallParts.length - 1].inlineData && /^CUSTOMER PHOTO/.test(drapeCallParts[drapeCallParts.length - 2].text),
        faceCalls[1].body.generationConfig.imageConfig.imageSize, faceCalls[1].body.generationConfig.imageConfig.aspectRatio],
      [3, true, '2K', '3:4', true, true, '4K', '9:16']);
    const sentPhoto = await sharp(Buffer.from(drapeCallParts[drapeCallParts.length - 1].inlineData.data, 'base64')).metadata();
    const shown = events.find((e) => e.type === 'image');
    eq('own photo, no generative fill: the narrow photo is padded to 9:16 with grey bands (not widened by the model), and the photo returned is cut back to its area',
      [`${sentPhoto.width}x${sentPhoto.height}`, /flat grey bands at its edges\. They are padding/.test(textOf(faceCalls[1])), shown.width < 768, shown.height],
      ['675x1200', true, true, 1024]);
    eq('own photo: the dressed photo is checked against the person photo; a changed face is draped once more with the correction, then passes',
      [faceAsks.filter((a) => a.ids.includes('same_face')).map((a) => [a.ids.includes('same_face'), a.person]), /Keep the exact face of the person in the PERSON PHOTO/.test(textOf(faceCalls[2])),
        /virtual fitting session/.test(textOf(faceCalls[2])), events[events.length - 1].quality.photo.passed, events[events.length - 1].quality.regenerated],
      [[[true, true], [true, true]], true, true, true, true]);
    eq('every other request keeps the normal size and 3:4',
      twoCalls.map((c) => [c.body.generationConfig.imageConfig.imageSize, c.body.generationConfig.imageConfig.aspectRatio]), [['2K', '3:4'], ['2K', '3:4']]);
    qa._setFetch(qaAnswer());

    // Since 10 Oct 2026 a gown is front and back too: the BACK design belongs to the back photograph.
    const gownCalls = script([() => answer([imagePart(FINAL)])]);
    ({ events } = await readEvents(await post('/generate', { clientId: 'gown-both', garment: 'GOWN', designs: [{ area: 'BACK', image: IMG }, { area: 'NECK', image: IMG }] })));
    eq('GOWN with BACK and NECK designs, no views: front then back; NECK in the front call only, BACK in the back call only',
      [events.filter((e) => e.type === 'image').map((e) => e.view), imagesIn(gownCalls[0]), imagesIn(gownCalls[1]), /THE FRONT VIEW of this exact gown/.test(textOf(gownCalls[1])), events[events.length - 1].type],
      [['front', 'back'], 1, 2, true, 'done']);
    qa._setFetch(qaAnswer());

    // Presentations over the real endpoint.
    eq('GET /options lists the presentations', opt.presentations, ['model', 'mannequin', 'sketch']);
    const manCalls = script([() => answer([imagePart(FINAL)])]);
    ({ events } = await readEvents(await post('/generate', { clientId: 'mannequin-1', garment: 'SAREE', presentation: 'maniquine', designs: [{ area: 'PALLU', image: IMG }] })));
    eq('mannequin over HTTP: start says so, front then back, two image calls, both prompts on a headless dress form, done says so',
      [events[0].presentation, events.filter((e) => e.type === 'image').map((e) => e.view), manCalls.length,
        manCalls.every((c) => /headless dress-form mannequin/.test(textOf(c)) && !/One professional Indian fashion model/.test(textOf(c))), events[events.length - 1].presentation],
      ['mannequin', ['front', 'back'], 2, true, 'mannequin']);
    const sketchCalls = script([() => answer([imagePart(FINAL)])]);
    ({ events } = await readEvents(await post('/generate', { clientId: 'sketch-1', garment: 'SAREE', presentation: 'sketch', designs: [{ area: 'PALLU', image: IMG }, { area: 'BORDER', image: IMG }] })));
    const sheet = events.find((e) => e.type === 'image');
    eq('sketch over HTTP: ONE image call, one "sheet" image with its figures and labels, done lists both sides',
      [sketchCalls.length, events.filter((e) => e.type === 'image').length, sheet.view, sheet.views, sheet.annotations.map((a) => a.part), events[events.length - 1].views, events[events.length - 1].presentation],
      [1, 1, 'sheet', ['front', 'back'], ['PALLU', 'BORDER', 'WORN_WITH'], ['front', 'back'], 'sketch']);
    check('...the image model got the illustration prompt with the label list', /THE ILLUSTRATION/.test(textOf(sketchCalls[0])) && /LABELS - write exactly these/.test(textOf(sketchCalls[0])));
    // The reader sees "Pallu" written twice on the first sheet, then the right labels.
    let labelReads = 0;
    qa._setFetch(async () => {
      const labels = sheet.annotations.map((a) => a.label);
      const texts = labelReads++ === 0 ? [...labels, labels[0], 'FRONT', 'BACK'] : [...labels, 'FRONT', 'BACK'];
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ texts }) }] } }] }), { status: 200 });
    });
    const relabelCalls = script([() => answer([imagePart(FINAL)])]);
    ({ events } = await readEvents(await post('/generate', { clientId: 'sketch-relabel', garment: 'SAREE', presentation: 'sketch', designs: [{ area: 'PALLU', image: IMG }, { area: 'BORDER', image: IMG }] })));
    const relabelDone = events[events.length - 1];
    eq('sketch: a label written twice is caught, the sheet is made once more with that named, and the second sheet passes',
      [relabelCalls.length, /Write the label "Pallu[^"]*" ONCE only/.test(textOf(relabelCalls[1])), relabelDone.quality.regenerated, relabelDone.quality.labels.passed],
      [2, true, true, true]);
    qa._setFetch(qaAnswer());
    streamCfg.detail = 'image';
    script([() => answer([imagePart(FINAL)])]);
    ({ events } = await readEvents(await post('/generate', { clientId: 'sketch-2', garment: 'GOWN', presentation: 'sketch', views: ['back'], designs: [{ area: 'BACK', image: IMG }] })));
    eq('the default image-only stream carries presentation, the sheet\'s views and the labels - they are for the caller',
      events.map((e) => [e.type, Object.keys(e).sort().join(',')]),
      [['start', 'jobId,presentation,type'], ['image', 'annotations,height,image,jobId,mimeType,type,view,views,width'], ['done', 'jobId,presentation,status,type,views']]);
    script([() => answer([imagePart(FINAL)])]);
    ({ events } = await readEvents(await post('/generate', { clientId: 'model-unchanged', garment: 'SAREE', views: ['front'], designs: [{ area: 'PALLU', image: IMG }] })));
    eq('...while a model request\'s image-only stream is exactly as before (no presentation, no annotations)',
      events.map((e) => [e.type, Object.keys(e).sort().join(',')]),
      [['start', 'jobId,type'], ['image', 'height,image,jobId,mimeType,type,view,width'], ['done', 'jobId,status,type,views']]);
    streamCfg.detail = 'full';
    res = await post('/generate', { clientId: 'x', garment: 'SAREE', presentation: 'sketch', modelImage: IMG, designs: [{ area: 'PALLU', image: IMG }] });
    eq('sketch with a modelImage: refused 400 before any image work', [res.status, (await res.json()).error.details[0].code], [400, 'PRESENTATION_CONFLICT']);

    // Cancelled while the photograph is being checked: CANCELLED, not "failed unexpectedly".
    qa._setFetch(async (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))));
    script([() => answer([imagePart(FINAL)])]);
    const checking = post('/generate', oneView({ clientId: 'cancel-in-check' }), { headers: { 'x-gateway-client-id': 'acct-check-cancel' } });
    await new Promise((r) => setTimeout(r, 250));
    const cancelCheck = await (await post('/cancel', { clientId: 'cancel-in-check' }, { headers: { 'x-gateway-client-id': 'acct-check-cancel' } })).json();
    ({ events } = await readEvents(await checking));
    eq('a cancel during the photograph check ends the stream with CANCELLED',
      [cancelCheck.cancelled, events[events.length - 1].type, events[events.length - 1].code], [true, 'error', 'CANCELLED']);
    qa._setFetch(qaAnswer());

    // Slow generation: heartbeat, capacity (1 slot in this test run), cancel.
    let geminiSignal = null;
    const slow = () => script([(opts) => new Promise((resolve, reject) => {
      geminiSignal = opts.signal;
      const timer = setTimeout(() => resolve(answer([imagePart(FINAL)])), 700);
      opts.signal.addEventListener('abort', () => { clearTimeout(timer); reject(opts.signal.reason); });
    })]);
    slow();
    const running = post('/generate', oneView({ clientId: 'slow-client' }), { headers: { 'x-gateway-client-id': 'acct-cancel' } });
    await new Promise((r) => setTimeout(r, 200));
    const busy = await post('/generate', oneView({ clientId: 'someone-else' }));
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
    const leaverRes = await post('/generate', oneView({ clientId: 'leaver' }), { signal: leaving.signal });
    const reader = leaverRes.body.getReader();
    await reader.read();
    leaving.abort();
    await new Promise((r) => setTimeout(r, 150));
    eq('a caller who disconnects stops the Gemini call and frees the slot', [geminiSignal && geminiSignal.aborted, capacity.stats().activeGenerations], [true, 0]);

    res = await post('/cancel', {});
    eq('cancel without clientId is 400', res.status, 400);
    script([() => answer([imagePart(FINAL)])]);
    ({ events } = await readEvents(await post('/generate', oneView({ clientId: 'after' }))));
    eq('the service works normally after all of that', events.map((e) => e.type), ['start', 'status', 'brief', 'status', 'status', 'status', 'status', 'image', 'done']);

    // ── The quality gate ──
    const SECOND = (await sharp({ create: { width: 768, height: 1024, channels: 3, background: '#113355' } }).png().toBuffer()).toString('base64');
    const blueOf = async (e) => Math.round((await sharp(Buffer.from(e.image.split(',')[1], 'base64')).stats()).channels[2].mean);
    eq('an inspected photograph that passes is reported as checked and passed, not regenerated',
      events[events.length - 1].quality, { checked: true, passed: true, regenerated: false, failures: [], references: { checked: true, passed: true, failures: [] }, pair: { checked: true, passed: true, failures: [] } });

    qa._setFetch(qaSequence(qaAnswer(['supporting_plain']), qaAnswer()));
    calls = script([() => answer([imagePart(FINAL)]), () => answer([imagePart(SECOND)])]);
    ({ events } = await readEvents(await post('/generate', oneView({ clientId: 'qa-regen' }))));
    const regenDone = events[events.length - 1];
    const firstBlue = await blueOf({ image: `data:image/png;base64,${FINAL}` });
    eq('a failed inspection regenerates once with the fault named, and the corrected photograph is returned',
      [events.filter((e) => e.type === 'status').map((e) => e.stage), regenDone.quality, calls.length, (await blueOf(events.find((e) => e.type === 'image'))) !== firstBlue],
      [['reading-references', 'generating', 'generating', 'checking', 'regenerating', 'checking', 'checking'], { checked: true, passed: true, regenerated: true, failures: [], references: { checked: true, passed: true, failures: [] }, pair: { checked: true, passed: true, failures: [] } }, 2, true]);
    const regenParts = calls[1].body.contents[0].parts;
    const correctionPart = regenParts[regenParts.length - 1].text;
    check('the regeneration carries the inspector\'s correction as the last instruction',
      /^CORRECTIONS - IMPORTANT/.test(correctionPart) && /The blouse is completely plain, one solid colour everywhere/.test(correctionPart), correctionPart);
    check('the failed inspection is logged with its evidence', logs.some((l) => /inspection failed: supporting_plain \(thin gold band at both sleeve ends\) - regenerating/.test(l)));

    qa._setFetch(qaSequence(qaAnswer(['supporting_plain']), qaAnswer(['supporting_plain', 'no_text'])));
    calls = script([() => answer([imagePart(FINAL)]), () => answer([imagePart(SECOND)])]);
    ({ events } = await readEvents(await post('/generate', oneView({ clientId: 'qa-worse' }))));
    eq('a regeneration that inspects worse is discarded: the first photograph is returned with its fault reported',
      [events[events.length - 1].quality.failures.map((f) => f.check), events[events.length - 1].quality.regenerated, (await blueOf(events.find((e) => e.type === 'image'))) === firstBlue],
      [['supporting_plain'], true, true]);

    qa._setFetch(async () => new Response('inspector down', { status: 500 }));
    calls = script([() => answer([imagePart(FINAL)])]);
    ({ events } = await readEvents(await post('/generate', oneView({ clientId: 'qa-down' }))));
    eq('if the inspection itself fails, the photograph is still returned, reported unchecked, with no regeneration',
      [events.some((e) => e.type === 'image'), events[events.length - 1].quality, calls.length], [true, { checked: false, passed: null, regenerated: false, failures: [], references: { checked: false, passed: null, failures: [] }, pair: { checked: false, passed: null, failures: [] } }, 1]);

    qa._setFetch(qaAnswer(['supporting_plain']));
    calls = script([() => answer([imagePart(FINAL)]), () => new Response(JSON.stringify({ error: { message: 'Request contains an invalid argument.' } }), { status: 400 })]);
    ({ events } = await readEvents(await post('/generate', oneView({ clientId: 'qa-regen-fails' }))));
    eq('if the regeneration itself fails, the first photograph is returned instead of an error',
      [events.some((e) => e.type === 'image'), events.some((e) => e.type === 'error'), events[events.length - 1].quality.failures.map((f) => f.check)],
      [true, false, ['supporting_plain']]);
    qa._setFetch(qaAnswer());

    check('no log line contains the API key or raw base64', !logs.some((l) => /AIzaFAKE|AIzaSyLEAK/.test(l) || /[A-Za-z0-9+/]{400,}/.test(l)), `${logs.length} log lines checked`);
    check('every request is logged once with its outcome', logs.filter((l) => /\[DesignStudio\] requestId=.* outcome=OK/.test(l)).length >= 2);
  } finally {
    console.log = realLog; console.warn = realWarn; console.error = realError;
    // This section's check results go to `logs` with the app's own lines; DS_TEST_LOG=<file> keeps them.
    if (process.env.DS_TEST_LOG) require('fs').writeFileSync(process.env.DS_TEST_LOG, logs.join('\n'));
    gemini._setFetch((...a) => fetch(...a));
    imageInput._setFetch((...a) => fetch(...a));
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
};
