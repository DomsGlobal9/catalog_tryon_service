#!/usr/bin/env node
// =============================================================================
// tests/run.js — the project's test suite. `npm test`
// =============================================================================
//
// Two tiers:
//
//   offline  (default)  no network, no server, no API credits. Pure logic:
//                       taxonomy integrity, canonicalisation, the instruction
//                       parser, query building, result filtering. Safe to run
//                       in CI on every commit.
//
//   --live              additionally drives a running service on
//                       http://localhost:4005 and spends real search credits.
//                       Generation endpoints are exercised for CONTRACT only
//                       (validation, auth, routing) - full image generation is
//                       slow and costly, so it is not run here.
//
// Exit code is non-zero if anything fails, so CI can gate on it.
//
const path = require('path');
const SRC = path.join(__dirname, '..', 'src');

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + name + (detail ? '  ' + detail : ''));
  } else {
    failures.push(name);
    console.log('  ✗ ' + name + (detail ? '  ' + detail : ''));
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? '' : '\n      got      ' + a + '\n      expected ' + e);
}

function section(title) {
  console.log('\n' + title);
}

// ─────────────────────────────────────────────────────────────────────────────
// OFFLINE
// ─────────────────────────────────────────────────────────────────────────────
async function offline() {
  // Discovery refuses to stream without a provider key. The provider is replaced
  // by a fake below, so no request ever leaves this process - this only lets the
  // configured code paths run.
  if (!process.env.SERPER_API_KEY) process.env.SERPER_API_KEY = 'offline-test-key-never-sent';
  // Offline means no database either: shared state runs in its in-memory mode.
  process.env.SHARED_STATE = 'off';

  const taxonomy = require(path.join(SRC, 'modules/discovery/taxonomy'));
  const { parseInstruction } = require(path.join(SRC, 'modules/discovery/services/instructionParser'));
  const { resolveSearchInput } = require(path.join(SRC, 'modules/discovery/services/searchInputResolver'));
  const { buildQuery } = require(path.join(SRC, 'modules/discovery/services/queryBuilder'));
  const { filterResults, hasUsableImageUrl, buildFetchable } =
    require(path.join(SRC, 'modules/discovery/services/designSearch.service'));
  const sysConstants = require(path.join(SRC, 'config/sys-constants-catalog'));

  section('TAXONOMY INTEGRITY  (all seven invariants)');
  const integ = taxonomy.integrity;
  check('integrity check passes', integ.ok, integ.ok ? '' : integ.errors.join('; '));
  eq('garment count', integ.garmentCount, taxonomy.EXPECTED_GARMENTS);
  eq('design area count', integ.designAreaCount, taxonomy.EXPECTED_DESIGN_AREAS);
  check('every garment has OVERALL',
    taxonomy.GARMENTS.every((g) => taxonomy.designTypeIds(g.id).includes('OVERALL')));
  check('no duplicate design ids within a garment',
    taxonomy.GARMENTS.every((g) => {
      const ids = taxonomy.designTypeIds(g.id);
      return new Set(ids).size === ids.length;
    }));

  section('CANONICALISATION  (one id per garment, platform-wide)');
  eq('lehenga  -> LEHANGA', taxonomy.canonicaliseGarment('lehenga'), 'LEHANGA');
  eq('LEHENGA  -> LEHANGA', taxonomy.canonicaliseGarment('LEHENGA'), 'LEHANGA');
  eq('lehanga  -> LEHANGA', taxonomy.canonicaliseGarment('lehanga'), 'LEHANGA');
  eq('kurti    -> KURTHI', taxonomy.canonicaliseGarment('kurti'), 'KURTHI');
  eq('unknown  -> null', taxonomy.canonicaliseGarment('tuxedo'), null);
  eq('display name is Lehenga', taxonomy.getGarment('LEHENGA').name, 'Lehenga');
  eq('search noun is lehenga', taxonomy.getGarment('LEHANGA').searchNoun, 'lehenga');

  section('GENERATION PROMPTS  (KURTI must not fall back to the generic prompt)');
  const generic = sysConstants.getCategoryPrompt('__unknown__');
  check('KURTI resolves to its own prompt', sysConstants.getCategoryPrompt('KURTI') !== generic);
  check('LEHENGA resolves to its own prompt', sysConstants.getCategoryPrompt('LEHENGA') !== generic);
  check('SHARARA resolves to its own prompt', sysConstants.getCategoryPrompt('SHARARA') !== generic);
  check('genuinely unknown falls back', sysConstants.getCategoryPrompt('TUXEDO') === generic);
  check('flat-lay fidelity rule present',
    sysConstants.getDynamicPrompt('FRONT', 'SAREE', {}, 'bg').includes('RULE #2B'));

  section('INSTRUCTION PARSER');
  let r = parseInstruction('i want red bridal kanjivaram saree pallu designs with heavy zari');
  eq('spec example 1', [r.category, r.designType, r.keywords],
    ['SAREE', 'PALLU', ['red', 'bridal', 'kanjivaram', 'heavy zari']]);
  r = parseInstruction('show me blue silk blouse neck designs');
  eq('spec example 2', [r.category, r.designType, r.keywords], ['BLOUSE', 'NECK', ['blue', 'silk']]);
  r = parseInstruction('heavy zari border in deep red', { categoryHint: 'LEHANGA' });
  eq('area resolved from an explicit category', [r.designType, r.designTypeScope], ['BORDER', 'LEHANGA']);
  r = parseInstruction('dupatta border design');
  eq('dupatta alone is the garment', [r.category, r.designType], ['DUPATTA', 'BORDER']);
  r = parseInstruction('anarkali dupatta design');
  eq('dupatta as an area of anarkali', [r.category, r.designType], ['ANARKALI', 'DUPATTA']);
  r = parseInstruction('i want some designs please');
  eq('all filler resolves to nothing', [r.category, r.keywords, r.confidence], [null, [], 'low']);
  r = parseInstruction('i want red zari saree pallu designs');
  eq('a part (pallu) beats a finish (zari) wherever it appears', [r.category, r.designType, r.keywords, r.unresolved],
    ['SAREE', 'PALLU', ['red', 'zari'], []]);
  r = parseInstruction('zari border saree');
  eq('zari border -> BORDER with zari kept as a word', [r.designType, r.keywords], ['BORDER', ['zari']]);
  r = parseInstruction('kurti embroidery neck');
  eq('embroidery neck -> NECK', [r.category, r.designType, r.keywords], ['KURTHI', 'NECK', ['embroidery']]);
  r = parseInstruction('saree zari work designs');
  eq('a finish alone is still chosen', [r.designType, r.keywords], ['ZARI_WORK', []]);
  r = parseInstruction('blouse neck and sleeve design');
  eq('two parts: the first wins, the second is a recognised word', [r.designType, r.keywords, r.unresolved], ['NECK', ['sleeve'], []]);
  r = parseInstruction('please help me thanks');
  eq('politeness alone resolves to nothing (no billed search)', [r.category, r.keywords], [null, []]);

  section('RESOLVER  (explicit input always wins)');
  const base = { clientId: 't', filters: {}, shotType: 'any', page: 1, limit: 20 };
  const R = (i) => resolveSearchInput(Object.assign({}, base, i));
  const throws = (i) => { try { R(i); return null; } catch (e) { return e.statusCode; } };
  eq('SAREE + SLEEVE rejected', throws({ category: 'SAREE', designType: 'SLEEVE', keywords: ['x'] }), 400);
  eq('designType without category rejected', throws({ designType: 'PALLU', keywords: ['x'] }), 400);
  eq('unknown category rejected', throws({ category: 'TUXEDO', keywords: ['x'] }), 400);
  eq('no search terms rejected', throws({ keywords: [] }), 400);
  let x = R({ category: 'SAREE', instruction: 'red lehenga border' });
  eq('explicit category wins, stray garment dropped', [x.category, x.designType, x.keywords],
    ['SAREE', 'BORDER', ['red']]);

  section('QUERY BUILDING  (backward compatibility is a hard rule)');
  const q = (i) => buildQuery(R(i)).query;
  eq('bare keywords unchanged', q({ keywords: ['red', 'bridal', 'saree'] }), 'red bridal saree');
  eq('LEHANGA searches "lehenga"', q({ category: 'LEHANGA', keywords: ['gold'] }), 'gold lehenga');
  eq('component search adds design + closeup',
    q({ category: 'SAREE', designType: 'BORDER', keywords: ['gold'] }), 'gold saree border closeup design');
  eq('OVERALL adds no closeup', q({ category: 'SAREE', designType: 'OVERALL', keywords: ['red'] }), 'red saree design');

  section('RESULT FILTERING AND THE fetchable CONTRACT');
  const retailer = { imageUrl: 'https://cdn.shop/a.jpg', thumbnailUrl: 'https://t/1', thumbnailWidth: 190, thumbnailHeight: 266, sourceDomain: 'shop.com', width: 1429, height: 2000 };
  const insta = { imageUrl: 'https://lookaside.instagram.com/x', thumbnailUrl: 'https://t/2', thumbnailWidth: 387, thumbnailHeight: 516, sourceDomain: 'www.instagram.com', width: 1440, height: 1920 };
  const fbNoThumb = { imageUrl: 'https://lookaside.fbsbx.com/y', thumbnailUrl: null, sourceDomain: 'www.facebook.com', width: 900, height: 900 };
  check('pinterest image is usable', hasUsableImageUrl({ imageUrl: 'https://i.pinimg.com/a.jpg', sourceDomain: 'in.pinterest.com' }));
  check('instagram image is not usable', !hasUsableImageUrl(insta));
  check('facebook detected via sourceDomain, not host', !hasUsableImageUrl(fbNoThumb));
  eq('fetchable falls back to the thumbnail with its REAL size',
    buildFetchable(insta, false), { url: 'https://t/2', width: 387, height: 516, from: 'thumbnailUrl', sizeExact: true });
  const filtered = filterResults([retailer, insta, fbNoThumb]);
  eq('unviewable result dropped, others kept and flagged',
    filtered.map((f) => [f.sourceDomain, f.imageUsable, f.fetchable.from]),
    [['shop.com', true, 'imageUrl'], ['www.instagram.com', false, 'thumbnailUrl']]);
  eq('original width/height never rewritten', filtered.map((f) => [f.width, f.height]), [[1429, 2000], [1440, 1920]]);

  await discoveryPlatformsAndStreaming();
  await sharedStateWithoutDatabase();

  section('RETRY BEHAVIOUR  (the fix must actually rescue a dropped download)');
  // The bug this proves: the response BODY read used to sit outside the retry
  // loop, so a connection dropping mid-download killed the whole job with no
  // second attempt. Here the body read is made to fail once, exactly as a real
  // reset does, and the call must still succeed.
  //
  // Both pipelines are checked. The women one was seen recovering against the
  // live API; the men one had never been observed doing so, which is why it is
  // pinned here rather than assumed.
  const realFetch = global.fetch;
  // fetch is stubbed below, so no real key is used - but both services refuse to
  // start without one, so give them a placeholder.
  const realKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = realKey || 'test-key-not-used';
  async function retryRescuesDroppedBody(mod, label) {
    const svc = require(path.join(SRC, mod));
    let attempt = 0;
    global.fetch = async () => {
      attempt++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => '',
        json: async () => {
          // First attempt: the connection drops while reading the body. This is
          // the exact shape undici raises on ECONNRESET mid-download.
          if (attempt === 1) {
            const e = new TypeError('terminated');
            e.cause = { code: 'ECONNRESET' };
            throw e;
          }
          return { candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: 'QUJD' } }] } }] };
        }
      };
    };
    try {
      const out = await svc.callGeminiImageGen([{ text: 'x' }], null);
      check(label + ': recovers from a dropped body read', typeof out === 'string' && out.startsWith('data:image/'),
        'attempts: ' + attempt);
      check(label + ': it genuinely retried (more than one attempt)', attempt > 1, 'attempts: ' + attempt);
    } catch (err) {
      check(label + ': recovers from a dropped body read', false, 'threw: ' + err.message);
    } finally {
      global.fetch = realFetch;
    }
  }

  await retryRescuesDroppedBody('services/catalogAiService', 'women');
  await retryRescuesDroppedBody('services/menAiService', 'men');
  if (realKey === undefined) delete process.env.GEMINI_API_KEY;

  section('SECURITY  (no credential may be committed)');
  const fs = require('fs');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|jsx|md|json)$/.test(e.name)) files.push(full);
    }
  })(path.join(__dirname, '..'));
  const leaked = files.filter((f) => /se_catalog_internal_key_v1_\d/.test(fs.readFileSync(f, 'utf8')));
  check('no hardcoded service key in tracked source', leaked.length === 0,
    leaked.length ? leaked.map((f) => path.relative(path.join(__dirname, '..'), f)).join(', ') : '');
}

// ─────────────────────────────────────────────────────────────────────────────
// DISCOVERY: platforms, result filters, multi-source search and SSE streaming.
// Offline: the search provider is replaced by a fake, but the HTTP is real - an
// Express server on a random local port - so the stream is read exactly the way a
// caller reads it.
// ─────────────────────────────────────────────────────────────────────────────
async function discoveryPlatformsAndStreaming() {
  const express = require('express');
  const D = (p) => require(path.join(SRC, 'modules/discovery', p));
  const { platformOf, upgradePinterestImage } = D('services/platforms');
  const { filterResults, _inflight } = D('services/designSearch.service');
  const { buildQuery } = D('services/queryBuilder');
  const { resolveSearchInput } = D('services/searchInputResolver');
  const { applyResultFilters, orientationOf, normaliseDomain } = D('services/resultFilters');
  const { searchSchema } = D('middleware/validate');
  const rateLimit = D('middleware/rateLimit');
  const cache = D('services/searchCache');
  const serper = D('providers/serper.provider');
  const { config } = D('discovery.config');
  const { ProviderError } = D('lib/errors');
  const routes = D('discovery.routes');

  section('PLATFORMS  (which site a result came from)');
  eq('pinterest.com', platformOf({ sourceDomain: 'in.pinterest.com' }), 'pinterest');
  eq('pinterest country domain', platformOf({ sourceDomain: 'www.pinterest.co.uk' }), 'pinterest');
  eq('pinimg image host', platformOf({ imageUrl: 'https://i.pinimg.com/236x/a/b.jpg', sourceDomain: 'x.com' }), 'pinterest');
  eq('instagram', platformOf({ sourceDomain: 'www.instagram.com' }), 'instagram');
  eq('facebook recognised by its image host alone', platformOf({ imageUrl: 'https://lookaside.fbsbx.com/x', sourceDomain: 'unknown' }), 'facebook');
  eq('a shop NAMED pinterest is not pinterest', platformOf({ sourceDomain: 'pinterestsarees.com', imageUrl: 'https://pinterestsarees.com/a.jpg' }), 'web');
  eq('pinterest.shopname.com is not pinterest', platformOf({ sourceDomain: 'pinterest.shopname.com' }), 'web');
  eq('ordinary retailer is web', platformOf({ sourceDomain: 'www.amazon.in', imageUrl: 'https://m.media-amazon.com/a.jpg' }), 'web');
  eq('nothing known is web', platformOf({}), 'web');

  section('PINTEREST IMAGE UPGRADE  (236px previews become 736px images)');
  const pin = { imageUrl: 'https://i.pinimg.com/236x/c2/8a/68/abc.jpg', width: 236, height: 354, sourceDomain: 'in.pinterest.com', thumbnailUrl: 'https://t/p' };
  eq('236x rewritten to 736x with an estimated size', upgradePinterestImage(pin),
    { url: 'https://i.pinimg.com/736x/c2/8a/68/abc.jpg', width: 736, height: 1104 });
  eq('474x also upgraded', upgradePinterestImage({ ...pin, imageUrl: 'https://i.pinimg.com/474x/c2/abc.jpg', width: 474, height: 474 }).url,
    'https://i.pinimg.com/736x/c2/abc.jpg');
  eq('736x left alone', upgradePinterestImage({ ...pin, imageUrl: 'https://i.pinimg.com/736x/c2/abc.jpg' }), null);
  eq('originals left alone', upgradePinterestImage({ ...pin, imageUrl: 'https://i.pinimg.com/originals/c2/abc.jpg' }), null);
  eq('other sites left alone', upgradePinterestImage({ imageUrl: 'https://cdn.shop/236x/a.jpg', width: 236, height: 300 }), null);
  eq('unknown size: url upgraded, size stays unknown', upgradePinterestImage({ imageUrl: pin.imageUrl, width: null, height: null }),
    { url: 'https://i.pinimg.com/736x/c2/8a/68/abc.jpg', width: null, height: null });
  const [pinOut] = filterResults([pin]);
  check('236px pin is KEPT (the old 400px floor dropped it)', !!pinOut);
  eq('pin: estimate flagged, original kept as fallback, platform set',
    pinOut && [pinOut.fetchable.url, pinOut.fetchable.sizeExact, pinOut.fetchable.fallbackUrl, pinOut.platform],
    ['https://i.pinimg.com/736x/c2/8a/68/abc.jpg', false, pin.imageUrl, 'pinterest']);
  eq('pin keeps its original reported size as provenance', pinOut && [pinOut.width, pinOut.height], [236, 354]);

  section('SIZE FLOOR  (junk dropped, small real designs kept)');
  const small = filterResults([
    { imageUrl: 'https://shop/a.jpg', width: 320, height: 480, sourceDomain: 'shop.in' },
    { imageUrl: 'https://shop/icon.png', width: 64, height: 64, sourceDomain: 'shop.in' },
    { imageUrl: 'https://shop/nosize.jpg', width: null, height: null, sourceDomain: 'shop.in' }
  ]);
  eq('320x480 kept, 64x64 icon dropped, unknown size kept', small.map((r) => r.imageUrl),
    ['https://shop/a.jpg', 'https://shop/nosize.jpg']);

  section('QUERY PER SOURCE  (web must stay byte-identical)');
  const rs = (i) => resolveSearchInput(Object.assign({ clientId: 't', filters: {}, shotType: 'any', page: 1, limit: 20 }, i));
  const qs = (i, source) => buildQuery({ ...rs(i), source }).query;
  eq('web unchanged', qs({ keywords: ['red', 'bridal', 'saree'] }, 'web'), 'red bridal saree');
  eq('no source given means web', buildQuery(rs({ keywords: ['red', 'bridal', 'saree'] })).query, 'red bridal saree');
  eq('pinterest appends its word', qs({ keywords: ['red', 'saree'] }, 'pinterest'), 'red saree pinterest');
  eq('instagram appends its word', qs({ keywords: ['red', 'saree'] }, 'instagram'), 'red saree instagram');
  eq('facebook uses the measured best wording', qs({ keywords: ['red', 'saree'] }, 'facebook'), 'red saree facebook page');
  eq('a word already typed is not repeated', qs({ keywords: ['red', 'saree', 'pinterest'] }, 'pinterest'), 'red saree pinterest');
  check('each source has its own cache entry',
    new Set(['web', 'pinterest', 'instagram', 'facebook'].map((s) => buildQuery({ ...rs({ keywords: ['x'] }), source: s }).cacheKey)).size === 4);

  section('RECENCY  (a real date restriction, sent to the provider)');
  const crypto = require('crypto');
  const plain = buildQuery(rs({ keywords: ['red', 'saree'] }));
  eq('"any" keeps the exact old cache key', plain.cacheKey,
    crypto.createHash('sha1').update(JSON.stringify({ query: 'red saree', page: 1, limit: 20 })).digest('hex'));
  const weekKey = buildQuery({ ...rs({ keywords: ['red', 'saree'] }), recency: 'week' });
  check('"week" gets its own cache entry (never served the any-time answer)', weekKey.cacheKey !== plain.cacheKey);
  eq('recency does not change the query words', weekKey.query, 'red saree');
  const realFetchForBody = global.fetch;
  const sentBodies = [];
  global.fetch = async (_url, opts) => {
    sentBodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ images: [] }) };
  };
  try {
    await D('providers/serper.provider').search({ query: 'red saree', page: 1, limit: 10, recency: 'week' });
    await D('providers/serper.provider').search({ query: 'red saree', page: 1, limit: 10, recency: 'any' });
    await D('providers/serper.provider').search({ query: 'red saree', page: 1, limit: 10 });
  } finally {
    global.fetch = realFetchForBody;
  }
  eq('week is sent to the provider as tbs=qdr:w', sentBodies[0].tbs, 'qdr:w');
  eq('"any" sends no date filter', 'tbs' in sentBodies[1], false);
  eq('an old request body without recency is unchanged', sentBodies[2],
    { q: 'red saree', num: 10, page: 1, gl: config.serper.country, hl: config.serper.language });

  section('PROVIDER RETRIES  ("too many requests" is retried; timeouts and bad keys are not)');
  const { postJson } = D('lib/httpClient');
  const fakeRes = (status, json = { images: [] }, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    text: async () => JSON.stringify(json), json: async () => json
  });
  async function scripted(steps, opts = {}) {
    const realF = global.fetch;
    const waits = [];
    let calls = 0;
    global.fetch = async () => {
      const step = steps[Math.min(calls, steps.length - 1)];
      calls++;
      if (step instanceof Error) throw step;
      return step;
    };
    try {
      const out = await postJson('https://provider.test', { body: {}, timeoutMs: 1000, providerName: 'Serper', retries: 2,
        retryBaseMs: 500, sleep: async (ms) => { waits.push(ms); }, ...opts });
      return { out, calls, waits };
    } catch (err) {
      return { err, calls, waits };
    } finally {
      global.fetch = realF;
    }
  }
  const timeoutErr = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  let rr = await scripted([fakeRes(429), fakeRes(200, { images: [1] })]);
  eq('429 then success -> answers after one retry', [rr.out && rr.out.images.length, rr.calls], [1, 2]);
  check('the retry waited at least the base delay', rr.waits.length === 1 && rr.waits[0] >= 500, 'waited ' + rr.waits.join(','));
  rr = await scripted([fakeRes(429), fakeRes(429), fakeRes(429)]);
  eq('429 three times -> gives up after 3 attempts', [rr.calls, rr.err && rr.err.statusCode], [3, 424]);
  check('final message says how many attempts', rr.err && /quota or rate limit exhausted\. \(after 3 attempts\)/.test(rr.err.message), rr.err && rr.err.message);
  check('backoff grows between attempts', rr.waits.length === 2 && rr.waits[1] > rr.waits[0], rr.waits.join(' -> '));
  rr = await scripted([fakeRes(503), fakeRes(200)]);
  eq('provider 503 then success -> retried', [!!rr.out, rr.calls], [true, 2]);
  rr = await scripted([Object.assign(new TypeError('fetch failed'), {}), fakeRes(200)]);
  eq('dropped connection then success -> retried', [!!rr.out, rr.calls], [true, 2]);
  rr = await scripted([fakeRes(401)]);
  eq('wrong key (401) is NOT retried', [rr.calls, rr.err && rr.err.message], [1, 'Serper rejected our credentials.']);
  rr = await scripted([fakeRes(400)]);
  eq('bad request (400) is NOT retried', rr.calls, 1);
  rr = await scripted([timeoutErr, fakeRes(200)]);
  eq('timeout is NOT retried (it already used the whole budget)', [rr.calls, rr.err && /did not respond within 1000ms\.$/.test(rr.err.message)], [1, true]);
  rr = await scripted([fakeRes(429, {}, { 'retry-after': '2' }), fakeRes(200)]);
  check('Retry-After from the provider is honoured', rr.out && rr.waits[0] >= 2000, 'waited ' + rr.waits[0]);
  rr = await scripted([fakeRes(429, {}, { 'retry-after': '3600' }), fakeRes(200)]);
  check('an absurd Retry-After is capped at 5s', rr.out && rr.waits[0] <= 5250, 'waited ' + rr.waits[0]);
  rr = await scripted([fakeRes(429), fakeRes(200)], { retries: 0 });
  eq('retries: 0 fails straight away', rr.calls, 1);

  section('PROVIDER CONCURRENCY CAP  (queue, never lock up)');
  const { createLimiter } = D('lib/limiter');
  const pause = (ms) => new Promise((res) => setTimeout(res, ms));
  let lim = createLimiter(2, { maxWaitMs: 5000 });
  let running = 0;
  let peak = 0;
  const done = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => lim.run(async () => {
    running++; peak = Math.max(peak, running);
    await pause(40);
    running--;
    return n;
  })));
  eq('six calls through a cap of 2: never more than 2 at once, all finish', [peak, done], [2, [1, 2, 3, 4, 5, 6]]);
  eq('nothing left running or queued', lim.stats(), { active: 0, queued: 0, max: 2 });
  lim = createLimiter(1, { maxWaitMs: 60 });
  const long = lim.run(() => pause(250));
  const waited = await lim.run(async () => 'should not run').then(() => null, (e) => e);
  check('a call that waits too long gives up with 424, not a hang', waited && waited.statusCode === 424 && /busy/.test(waited.message), waited && waited.message);
  await long;
  eq('after that, the slot is free again', [await lim.run(async () => 'ok'), lim.stats().active, lim.stats().queued], ['ok', 0, 0]);
  lim = createLimiter(1, { maxWaitMs: 1000 });
  const boom = await lim.run(async () => { throw new Error('boom'); }).then(() => null, (e) => e.message);
  eq('a failing call still frees its slot', [boom, await lim.run(async () => 'next ran')], ['boom', 'next ran']);

  section('REQUEST VALIDATION  (sources, recency and resultFilters)');
  eq('recency defaults to any', searchSchema.safeParse({ clientId: 'a', keywords: ['x'] }).data.recency, 'any');
  eq('recency is case-insensitive', searchSchema.safeParse({ clientId: 'a', keywords: ['x'], recency: 'Month' }).data.recency, 'month');
  check('unknown recency rejected', !searchSchema.safeParse({ clientId: 'a', keywords: ['x'], recency: 'decade' }).success);
  const parse = (b) => searchSchema.safeParse(Object.assign({ clientId: 'a', keywords: ['x'] }, b));
  eq('sources default to web', parse({}).data.sources, ['web']);
  eq('repeats and capitals collapsed', parse({ sources: ['Pinterest', 'pinterest', 'WEB'] }).data.sources, ['pinterest', 'web']);
  eq('a single string is a list of one', parse({ sources: 'instagram' }).data.sources, ['instagram']);
  eq('four platforms with one repeated is accepted', parse({ sources: ['web', 'pinterest', 'instagram', 'facebook', 'web'] }).data.sources.length, 4);
  check('unknown source rejected', !parse({ sources: ['tiktok'] }).success);
  check('empty sources rejected', !parse({ sources: [] }).success);
  check('misspelt resultFilter rejected, not silently ignored', !parse({ resultFilters: { minWidht: 500 } }).success);
  eq('resultFilters normalised', parse({ resultFilters: { minWidth: '600', orientation: 'Portrait' } }).data.resultFilters,
    { minWidth: 600, orientation: 'portrait' });

  section('RESULT FILTERS  (checked against real data, so guaranteed)');
  const mk = (o) => Object.assign({ imageUrl: 'https://x/a.jpg', sourceDomain: 'x.com', fetchable: { from: 'imageUrl', width: 800, height: 1200 } }, o);
  const pool = [
    mk({ id: 'portrait' }),
    mk({ id: 'landscape', fetchable: { from: 'imageUrl', width: 1200, height: 800 } }),
    mk({ id: 'square', fetchable: { from: 'imageUrl', width: 1000, height: 1010 } }),
    mk({ id: 'thumb', fetchable: { from: 'thumbnailUrl', width: 380, height: 500 } }),
    mk({ id: 'nosize', fetchable: { from: 'imageUrl', width: null, height: null } }),
    mk({ id: 'amazon', sourceDomain: 'www.amazon.in', imageUrl: 'https://m.media-amazon.com/a.jpg' })
  ];
  const ids = (f) => applyResultFilters(pool, f).kept.map((r) => r.id);
  eq('no filters keeps everything', ids({}), ['portrait', 'landscape', 'square', 'thumb', 'nosize', 'amazon']);
  eq('fullSizeOnly drops preview-only results', ids({ fullSizeOnly: true }), ['portrait', 'landscape', 'square', 'nosize', 'amazon']);
  eq('minWidth is strict about unknown sizes', ids({ minWidth: 900 }), ['landscape', 'square']);
  eq('orientation portrait', ids({ orientation: 'portrait' }), ['portrait', 'thumb', 'amazon']);
  eq('square allows a small tolerance', ids({ orientation: 'square' }), ['square']);
  eq('excludeDomains matches subdomains, and accepts a pasted URL', ids({ excludeDomains: ['https://www.Amazon.in/shop'] }),
    ['portrait', 'landscape', 'square', 'thumb', 'nosize']);
  eq('removedBy counts each reason', applyResultFilters(pool, { fullSizeOnly: true, excludeDomains: ['amazon.in'] }).removedBy,
    { fullSizeOnly: 1, minWidth: 0, orientation: 0, excludeDomains: 1 });
  eq('orientation of an unknown size is unknown', orientationOf(null, 10), null);
  eq('domain normalised', normaliseDomain(' HTTPS://WWW.Meesho.com:443/x?y '), 'meesho.com');

  section('RATE LIMIT  (budget counted in real provider calls)');
  rateLimit.reset();
  const spend = async (cost) => { const err = await rateLimit.charge('budget', cost); return err ? err.statusCode : 200; };
  const four = ['web', 'pinterest', 'instagram', 'facebook'];
  const seq = [];
  for (let i = 0; i < 4; i++) seq.push(await spend(4)); // 16 of 20 used
  seq.push(await spend(2));                             // 18
  seq.push(await spend(4));                             // would be 22: refused, NOT charged
  seq.push(await spend(2));                             // 20: still allowed
  seq.push(await spend(1));                             // 21: refused
  seq.push(await spend(0));                             // fully cached search: free even with no budget left
  eq('four calls cost four; a refused request costs nothing; a cached one is free', seq,
    [200, 200, 200, 200, 200, 429, 200, 429, 200]);
  const refusal = await rateLimit.charge('budget', 1);
  check('refusal says how long to wait', refusal && refusal.retryAfterSec >= 1 && refusal.retryAfterSec <= 60, refusal && 'retry in ' + refusal.retryAfterSec + 's');
  rateLimit.reset();

  // Fake provider. What it returns is decided by the words in the query.
  // Delays are far apart so arrival order is stable even on coarse OS timers.
  const realSearch = serper.search;
  const calls = [];
  const R = (id, o) => Object.assign({
    id: 'result_' + id, position: 1, title: id, imageUrl: 'https://img/' + id + '.jpg', thumbnailUrl: 'https://t/' + id,
    thumbnailWidth: 300, thumbnailHeight: 400, sourceUrl: 'https://src/' + id, sourceDomain: 'shop.in', width: 1000, height: 1400
  }, o);
  const PIN = R('pin', { imageUrl: 'https://i.pinimg.com/236x/aa/pin.jpg', width: 236, height: 354, sourceDomain: 'in.pinterest.com' });
  const DELAY = { instagram: 10, pinterest: 90, facebook: 180, web: 270 };
  serper.search = async ({ query, limit }) => {
    calls.push(query);
    const src = /facebook/.test(query) ? 'facebook' : /instagram/.test(query) ? 'instagram' : /pinterest/.test(query) ? 'pinterest' : 'web';
    await new Promise((r) => setTimeout(r, DELAY[src] + (/slow/.test(query) ? 400 : 0)));
    if (src === 'facebook') throw new ProviderError('Serper did not respond within 15000ms.');
    if (src === 'web') {
      return { results: [R('shop1'), PIN, R('insta', { sourceDomain: 'www.instagram.com', imageUrl: 'https://lookaside.instagram.com/x' })], rawCount: limit };
    }
    if (src === 'pinterest') {
      return { results: [PIN, R('pin2', { imageUrl: 'https://i.pinimg.com/736x/bb/pin2.jpg', sourceDomain: 'in.pinterest.com' }), R('retailer-in-pin-search')], rawCount: 3 };
    }
    return { results: [R('ig1', { sourceDomain: 'www.instagram.com', imageUrl: 'https://lookaside.instagram.com/ig1' })], rawCount: 1 };
  };

  const { identify } = require(path.join(SRC, 'middleware/identity'));
  const { useSharedState } = D('sharedState');
  const app = express();
  app.use(identify); // as in src/index.js: sets req.account from the gateway header
  app.use('/d', routes);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port + '/d';
  const post = (p, body, opts = {}) =>
    fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...opts });

  // Reads an SSE response exactly as a client would: split on blank lines, keep
  // only `data:` frames. `onFirst` lets a test walk away after the first event.
  async function readStream(res, onFirst) {
    const events = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!frame.startsWith('data: ')) continue;
          events.push(JSON.parse(frame.slice(6)));
          if (onFirst && events.length === 1) onFirst();
        }
      }
    } catch (err) {
      if (!onFirst) throw err; // an abort we asked for is expected
    }
    return events;
  }

  try {
    cache.clear();
    section('JSON SEARCH ACROSS SOURCES  (fake provider, real HTTP)');
    let res = await post('/search', { clientId: 'j1', keywords: ['red', 'saree'], sources: four });
    let body = await res.json();
    check('one failing source still answers 200', res.status === 200, 'HTTP ' + res.status);
    eq('sources reported in the order asked', body.sources.map((s) => [s.source, s.status]),
      [['web', 'ok'], ['pinterest', 'ok'], ['instagram', 'ok'], ['facebook', 'error']]);
    eq('failed source carries its reason', body.sources[3].error,
      { code: 'PROVIDER_UNAVAILABLE', message: 'Serper did not respond within 15000ms.' });
    eq('a design found by two sources appears once', body.results.filter((r) => r.id === 'result_pin').length, 1);
    eq('pinterest search drops the retailer image it also found', body.sources[1].offPlatform, 1);
    check('every result says its platform and which search found it', body.results.every((r) => r.platform && r.foundBy));
    eq('JSON order follows the request, not arrival', body.results.map((r) => r.foundBy),
      ['web', 'web', 'web', 'pinterest', 'instagram']);
    eq('the duplicate is counted on the source that lost', body.sources[1].duplicates, 1);
    eq('top-level query is the first source', body.query, 'red saree');

    res = await post('/search', { clientId: 'j1', keywords: ['red', 'saree'], sources: four });
    body = await res.json();
    check('repeat is served from cache', body.sources.filter((s) => s.status === 'ok').every((s) => s.cached));

    res = await post('/search', { clientId: 'j2', keywords: ['red', 'saree'], sources: ['facebook'] });
    body = await res.json();
    eq('every source failing keeps the 424 contract', [res.status, body.error && body.error.code], [424, 'PROVIDER_UNAVAILABLE']);

    res = await post('/search', { clientId: 'j3', keywords: ['red', 'saree'], sources: ['web', 'instagram'], resultFilters: { fullSizeOnly: true } });
    body = await res.json();
    check('fullSizeOnly removes Instagram previews end to end',
      res.status === 200 && body.results.length > 0 && body.results.every((r) => r.fetchable.from === 'imageUrl'),
      body.sources && body.sources.map((s) => `${s.source}: ${s.returned} kept, ${s.removedByFilters} removed`).join(' | '));

    res = await post('/search', { clientId: 'j4', keywords: ['red', 'saree'] });
    body = await res.json();
    eq('a request without sources is still one web search', body.sources.map((s) => s.source), ['web']);

    section('BUDGET OVER HTTP  (only uncached provider calls are charged)');
    cache.clear();
    rateLimit.reset();
    const budget = [];
    budget.push((await post('/search', { clientId: 'clicker', keywords: ['budget', 'probe'], sources: ['web', 'pinterest', 'instagram'] })).status); // 3 calls
    for (let i = 0; i < 12; i++) {
      // Same search, different result filters each time - exactly what clicking
      // through filters in the UI does. All cached, so all free.
      budget.push((await post('/search', { clientId: 'clicker', keywords: ['budget', 'probe'], sources: ['web', 'pinterest', 'instagram'],
        resultFilters: { minWidth: 100 + i } })).status);
    }
    check('twelve filter changes on a cached search are never rate limited', budget.every((s) => s === 200), budget.join(','));
    for (let i = 0; i < 5; i++) await post('/search', { clientId: 'clicker', keywords: ['fresh', String(i)], sources: ['web', 'pinterest', 'instagram'] }); // 3 + 15 = 18
    let over = await post('/search', { clientId: 'clicker', keywords: ['fresh', 'more'], sources: ['web', 'pinterest', 'instagram'] }); // 21
    eq('new searches are still limited', over.status, 429);
    check('limited response carries Retry-After', !!over.headers.get('retry-after'), 'Retry-After: ' + over.headers.get('retry-after'));
    over = await post('/search/stream', { clientId: 'clicker', keywords: ['fresh', 'stream'], sources: ['web', 'pinterest', 'instagram'] });
    eq('stream refused as JSON 429 before opening', [over.status, /json/.test(over.headers.get('content-type') || '')], [429, true]);
    const stillFree = await post('/search', { clientId: 'clicker', keywords: ['budget', 'probe'], sources: ['web', 'pinterest', 'instagram'] });
    eq('a cached search still works while out of budget', stillFree.status, 200);
    rateLimit.reset();

    section('SINGLE-FLIGHT  (identical searches at the same moment share one call)');
    cache.clear();
    calls.length = 0;
    await Promise.all([1, 2, 3].map((n) => post('/search', { clientId: 'sf' + n, keywords: ['twin', 'query'] }).then((r) => r.json())));
    eq('three identical searches at once -> one provider call', calls.filter((q) => q === 'twin query').length, 1);
    eq('nothing left in flight afterwards', _inflight.size, 0);

    section('SSE STREAM  (fake provider, real HTTP)');
    cache.clear();
    res = await post('/search/stream', { clientId: 's1', keywords: ['red', 'saree'], sources: four });
    check('stream opens as text/event-stream', /text\/event-stream/.test(res.headers.get('content-type') || ''), res.headers.get('content-type'));
    let events = await readStream(res);
    eq('event order: start, one per source, done', events.map((e) => e.type), ['start', 'source', 'source', 'source', 'source', 'done']);
    eq('sources arrive fastest first', events.filter((e) => e.type === 'source').map((e) => e.source), ['instagram', 'pinterest', 'facebook', 'web']);
    eq('start announces every query before any result arrives', events[0].sources.map((s) => s.query),
      ['red saree', 'red saree pinterest', 'red saree instagram', 'red saree facebook page']);
    const fbEvent = events.find((e) => e.type === 'source' && e.source === 'facebook');
    eq('a failed source is an event, not a broken stream', [fbEvent.status, fbEvent.error.code, 'results' in fbEvent],
      ['error', 'PROVIDER_UNAVAILABLE', false]);
    const doneEvent = events[events.length - 1];
    eq('done summarises the whole search', [doneEvent.status, doneEvent.sources.map((s) => s.source)], ['partial', four]);
    const streamed = events.filter((e) => e.type === 'source').flatMap((e) => e.results || []);
    eq('no design is streamed twice', streamed.length, new Set(streamed.map((r) => r.id)).size);
    eq('done.total matches what was streamed', doneEvent.total, streamed.length);

    res = await post('/search/stream', { clientId: 's2', keywords: ['red'], sources: ['tiktok'] });
    body = await res.json();
    eq('a bad request is refused as JSON before any stream opens',
      [res.status, /json/.test(res.headers.get('content-type') || ''), body.error.code], [400, true, 'VALIDATION_ERROR']);

    config.isConfigured = false;
    res = await post('/search/stream', { clientId: 's3', keywords: ['red'] });
    body = await res.json();
    eq('switched-off discovery answers 424 JSON, not a stream', [res.status, body.error.code], [424, 'DISCOVERY_NOT_CONFIGURED']);
    config.isConfigured = true;

    res = await post('/search/stream', { clientId: 's4', keywords: ['all', 'down'], sources: ['facebook'] });
    events = await readStream(res);
    const last = events[events.length - 1];
    eq('every source failing still ends cleanly, marked failed', [res.status, last.type, last.status], [200, 'done', 'failed']);

    section('SSE CALLER LEAVING EARLY  (must not crash or leak)');
    cache.clear();
    const ac = new AbortController();
    res = await post('/search/stream', { clientId: 's5', keywords: ['slow', 'one'], sources: four }, { signal: ac.signal });
    events = await readStream(res, () => ac.abort());
    check('caller disconnected right after the start event', events.length >= 1 && events[0].type === 'start', events.length + ' event(s) read');
    await new Promise((r) => setTimeout(r, 1000)); // the abandoned provider calls finish in ~670ms
    res = await post('/search', { clientId: 's6', keywords: ['slow', 'one'], sources: ['web', 'pinterest', 'instagram'] });
    body = await res.json();
    check('server still answers normally afterwards', res.status === 200, 'HTTP ' + res.status);
    check('the abandoned calls finished and filled the cache', body.sources && body.sources.every((s) => s.cached),
      body.sources && body.sources.map((s) => s.source + ':' + s.cached).join(' '));
    eq('nothing left in flight', _inflight.size, 0);

    section('BUDGET FOLLOWS THE GATEWAY CUSTOMER  (a new clientId does not reset it)');
    cache.clear();
    rateLimit.reset();
    const asAccount = (account, clientId, words) => post('/search', { clientId, keywords: words, sources: ['web', 'pinterest', 'instagram', 'facebook'] },
      { headers: { 'Content-Type': 'application/json', ...(account ? { 'x-gateway-client-id': account } : {}) } });
    const acct = [];
    for (let i = 0; i < 5; i++) acct.push((await asAccount('cust-A', 'user-' + i, ['acct', 'probe', String(i)])).status); // 4 calls each
    eq('same customer, five different clientIds: five four-platform searches use the 20 calls', acct, [200, 200, 200, 200, 200]);
    const sixth = await asAccount('cust-A', 'user-new', ['acct', 'probe', 'six']);
    eq('...and a sixth with yet another clientId is still refused (20/20 used)', sixth.status, 429);
    eq('a different customer has their own budget', (await asAccount('cust-B', 'user-new', ['acct', 'probe', 'six'])).status, 200);
    eq('a malformed customer header is ignored, not trusted', (await asAccount('bad id with spaces', 'solo', ['acct', 'probe', 'seven'])).status, 200);
    rateLimit.reset();

    section('SHARED CACHE AND BUDGET ACROSS SERVERS  (fake shared store)');
    // A stand-in for the Postgres adapter: one Map plays the database both
    // "servers" see. Clearing this process's memory cache plays the second server.
    const sharedRows = new Map();
    const sharedBudget = new Map();
    let sharedDown = false;
    const guard = () => { if (sharedDown) throw new Error('database down'); };
    useSharedState({
      consume: async (bucket, cost, { limit }) => {
        const used = sharedBudget.get(bucket) || 0;
        if (used + cost > limit) return { allowed: false, used, limit, retryAfterSec: 30 };
        sharedBudget.set(bucket, used + cost);
        return { allowed: true, used: used + cost, limit, retryAfterSec: 30 };
      },
      cacheGet: async (key) => { guard(); const row = sharedRows.get(key); return row ? { value: row.value, expiresAt: row.expiresAt } : null; },
      cacheHasMany: async (keys) => { guard(); return new Set(keys.filter((k) => sharedRows.has(k))); },
      cacheSet: async (key, value, ttlSec) => { guard(); sharedRows.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 }); }
    });
    try {
      cache.clear();
      calls.length = 0;
      res = await post('/search', { clientId: 'srv', keywords: ['shared', 'probe'], sources: ['web', 'pinterest'] });
      body = await res.json();
      await new Promise((r) => setTimeout(r, 20)); // shared writes are fire-and-forget
      eq('server 1 pays for two provider calls and stores them in the shared cache', [res.status, calls.length, sharedRows.size], [200, 2, 2]);

      cache.clear(); // "server 2": nothing in its own memory
      calls.length = 0;
      res = await post('/search', { clientId: 'srv', keywords: ['shared', 'probe'], sources: ['web', 'pinterest'] });
      const second = await res.json();
      eq('server 2 answers the same search with no provider call, marked cached', [res.status, calls.length, second.cached], [200, 0, true]);
      eq('...with the same results', second.results.map((r) => r.id), body.results.map((r) => r.id));

      cache.clear();
      sharedBudget.clear();
      for (let i = 0; i < 5; i++) await post('/search', { clientId: 'srv', keywords: ['budget', 'shared', String(i)], sources: ['web', 'pinterest', 'instagram', 'facebook'] });
      const out = await post('/search', { clientId: 'srv', keywords: ['budget', 'shared', 'x'], sources: ['web'] });
      eq('the budget is spent from the shared counter', [out.status, sharedBudget.get('client:srv')], [429, 20]);
      const cachedOnly = await post('/search', { clientId: 'srv', keywords: ['shared', 'probe'], sources: ['web', 'pinterest'] });
      eq('a search found in the shared cache is free even with no budget', cachedOnly.status, 200);

      sharedDown = true;
      cache.clear();
      sharedBudget.clear();
      calls.length = 0;
      res = await post('/search', { clientId: 'srv-down', keywords: ['database', 'down'], sources: ['web'] });
      eq('shared cache down: the search still works, straight from the provider', [res.status, calls.length], [200, 1]);
    } finally {
      useSharedState(null);
    }
  } finally {
    serper.search = realSearch;
    config.isConfigured = !!config.serper.apiKey;
    cache.clear();
    rateLimit.reset();
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED STATE, NO DATABASE  (fallbacks, generation admission, job ownership)
// The same code against a real Postgres, across real processes: tests/shared-state.js
// ─────────────────────────────────────────────────────────────────────────────
async function sharedStateWithoutDatabase() {
  const { createStore } = require(path.join(SRC, 'lib/shared/store'));
  const { createRateLimiter } = require(path.join(SRC, 'lib/shared/rateLimiter'));
  const { createJobRegistry } = require(path.join(SRC, 'lib/shared/jobRegistry'));
  const quiet = { log() {}, warn() {} };

  section('SHARED STATE FALLBACK  (no database: same rules, in this server\'s memory)');
  const off = createStore({ pool: null, schema: 'se_catalog', enabled: false, log: quiet });
  const limiter = createRateLimiter({ store: off });
  const got = [];
  for (let i = 0; i < 4; i++) got.push((await limiter.consume('b', 1, { limit: 3, windowSec: 60 })).allowed);
  eq('limit 3: three allowed, the fourth refused', got, [true, true, true, false]);
  await limiter.refund('b', 1, { windowSec: 60 });
  eq('a refunded unit can be spent again', (await limiter.consume('b', 1, { limit: 3, windowSec: 60 })).allowed, true);
  eq('a cost larger than the whole limit is refused', (await limiter.consume('big', 5, { limit: 3, windowSec: 60 })).allowed, false);
  eq('cost 0 is always allowed', (await limiter.consume('b', 0, { limit: 3, windowSec: 60 })).allowed, true);

  let poolCalls = 0;
  const broken = createStore({ pool: { query: async () => { poolCalls++; throw new Error('connection refused'); } }, schema: 'se_catalog', log: quiet });
  broken._setReady(true);
  const brokenLimiter = createRateLimiter({ store: broken });
  const r1 = await brokenLimiter.consume('x', 1, { limit: 5, windowSec: 60 });
  const r2 = await brokenLimiter.consume('x', 1, { limit: 5, windowSec: 60 });
  for (let i = 0; i < 5; i++) await brokenLimiter.consume('x', 0.5, { limit: 50, windowSec: 60 });
  eq('database failing: requests still answered from memory', [r1.allowed, r1.shared, r2.allowed, r2.used], [true, false, true, 2]);
  eq('two failures in a row, then the database is left alone for a cooldown (not one attempt per request)', poolCalls, 2);
  let flakyCalls = 0;
  const flaky = createStore({ pool: { query: async () => { flakyCalls++; if (flakyCalls === 1) throw new Error('slow cold connection'); return { rows: [{ used_after: 1, used_before: null, retry_after: 30 }] }; } }, schema: 'se_catalog', log: quiet });
  flaky._setReady(true);
  const flakyLimiter = createRateLimiter({ store: flaky });
  const f1 = await flakyLimiter.consume('z', 1, { limit: 5, windowSec: 60 });
  const f2 = await flakyLimiter.consume('z', 1, { limit: 5, windowSec: 60 });
  eq('ONE failed query does not switch sharing off: the next request is shared again', [f1.shared, f2.shared, flaky.status().healthy], [false, true, true]);
  eq('status reports it unhealthy', broken.status().healthy, false);
  let slowCalls = 0;
  const slow = createStore({ pool: { query: () => { slowCalls++; return new Promise(() => {}); } }, schema: 'se_catalog', timeoutMs: 50, log: quiet });
  slow._setReady(true);
  const t0 = Date.now();
  const slowResult = await createRateLimiter({ store: slow }).consume('y', 1, { limit: 5, windowSec: 60 });
  check('a hung database costs at most the query timeout', slowResult.allowed && Date.now() - t0 < 500, (Date.now() - t0) + 'ms');

  const registry = createJobRegistry({ store: off, instanceId: 'test', log: quiet });
  const job = await registry.register('women:acct:u1', 'women');
  eq('cancel finds a job on this server', await registry.cancel('women:acct:u1'), true);
  eq('...and stops it', job.signal.aborted, true);
  eq('cancelling again finds nothing', await registry.cancel('women:acct:u1'), false);
  await job.finish();
  await job.finish();
  eq('finishing twice is harmless', registry.stats().runningHere, 0);

  section('GENERATION ADMISSION  (budget, capacity, replacing the previous job)');
  process.env.SHARED_STATE = 'off';
  process.env.GENERATION_RATE_LIMIT_PER_HOUR = '2';
  process.env.MAX_CONCURRENT_GENERATIONS = '1';
  const { admitGeneration, cancelGeneration } = require(path.join(SRC, 'middleware/generationGuard'));
  const capacity = require(path.join(SRC, 'lib/capacity'));
  const fakeReq = (account) => ({ account });
  const fakeRes = () => ({
    headers: {}, statusCode: 200, body: null,
    set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  });
  const silence = console.log; const silenceWarn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    const res1 = fakeRes();
    const first = await admitGeneration(fakeReq('A'), res1, { clientId: 'u1', pipeline: 'women' });
    const res2 = fakeRes();
    const second = await admitGeneration(fakeReq('A'), res2, { clientId: 'u1', pipeline: 'women' });
    const capacityRefusal = [second, res2.statusCode, res2.headers['retry-after'], first.job.signal.aborted];
    await first.release();
    const res3 = fakeRes();
    const third = await admitGeneration(fakeReq('A'), res3, { clientId: 'u1', pipeline: 'women' });
    await third.release();
    const res4 = fakeRes();
    const fourth = await admitGeneration(fakeReq('A'), res4, { clientId: 'u2', pipeline: 'men' });
    console.log = silence; console.warn = silenceWarn;

    eq('a second job for the same client stops the first', capacityRefusal[3], true);
    eq('with one slot still busy it is refused: 429, Retry-After 10', capacityRefusal.slice(0, 3), [null, 429, '10']);
    check('a capacity refusal does not use the customer\'s budget', third !== null, 'third request ' + (third ? 'admitted' : 'refused: ' + JSON.stringify(res3.body)));
    eq('the budget is per customer across clientIds and pipelines: third generation this hour refused', [fourth, res4.statusCode], [null, 429]);
    check('budget refusal says when to retry', Number(res4.headers['retry-after']) >= 1 && Number(res4.headers['retry-after']) <= 3600 && /per hour/.test(res4.body.error),
      'Retry-After ' + res4.headers['retry-after'] + ': ' + res4.body.error);
    eq('every slot released', capacity.stats().activeGenerations, 0);

    console.log = () => {}; console.warn = () => {};
    const cJob = await admitGeneration(fakeReq('C'), fakeRes(), { clientId: 'shared-name', pipeline: 'women' });
    const otherCustomer = await cancelGeneration(fakeReq('D'), { clientId: 'shared-name', pipeline: 'women' });
    const directCall = await cancelGeneration(fakeReq(null), { clientId: 'shared-name', pipeline: 'women' });
    const abortedByOthers = cJob.job.signal.aborted;
    const wrongPipeline = await cancelGeneration(fakeReq('C'), { clientId: 'shared-name', pipeline: 'men' });
    const owner = await cancelGeneration(fakeReq('C'), { clientId: 'shared-name', pipeline: 'women' });
    await cJob.release();
    console.log = silence; console.warn = silenceWarn;
    eq('another customer using the same clientId cannot cancel the job', [otherCustomer, directCall, abortedByOthers], [false, false, false]);
    eq('cancel on the other pipeline does not touch it', wrongPipeline, false);
    eq('the owner can', [owner, cJob.job.signal.aborted], [true, true]);
  } finally {
    console.log = silence; console.warn = silenceWarn;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE  (--live)
// ─────────────────────────────────────────────────────────────────────────────
async function live() {
  const fs = require('fs');
  const KEY = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
    .split(/\r?\n/).find((l) => l.startsWith('SERVICE_API_KEY='))
    .slice('SERVICE_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
  const H = { 'Content-Type': 'application/json', 'x-api-key': KEY };
  const B = process.env.TEST_BASE_URL || 'http://localhost:4005';

  const call = async (path_, body, method = 'POST') => {
    const r = await fetch(B + path_, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };

  section('LIVE: health and auth');
  const h = await fetch(B + '/health');
  check('GET /health needs no key', h.status === 200);
  const noKey = await fetch(B + '/api/v1/discovery/categories');
  check('no key is rejected', noKey.status === 401);
  const badKey = await fetch(B + '/api/v1/draping/generate-catalog/men',
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'WRONG' }, body: '{}' });
  check('wrong key is rejected on men too', badKey.status === 401);

  section('LIVE: discovery');
  let r = await call('/api/v1/discovery/taxonomy', null, 'GET');
  check('taxonomy served', r.status === 200 && r.body.designAreaCount === 107, r.body && (r.body.garmentCount + '/' + r.body.designAreaCount));
  r = await call('/api/v1/discovery/search', { clientId: 'test', keywords: ['red', 'bridal', 'saree'] });
  check('search returns results', r.status === 200 && r.body.results.length > 0,
    r.status === 200 ? r.body.results.length + ' results' : 'HTTP ' + r.status + ' ' + (r.body && r.body.error && r.body.error.message));
  check('every result carries a usable fetchable url',
    r.status === 200 && r.body.results.every((x) => x.fetchable && x.fetchable.url));
  r = await call('/api/v1/discovery/search', { clientId: 'test', category: 'SAREE', designType: 'SLEEVE', keywords: ['x'] });
  check('invalid garment/area pair rejected', r.status === 400 && r.body.error.code === 'VALIDATION_ERROR');

  section('LIVE: platforms and streaming  (real provider - spends credits)');
  const plat = ['web', 'pinterest', 'instagram', 'facebook'];
  r = await call('/api/v1/discovery/search', { clientId: 'live-platforms', keywords: ['red', 'bridal', 'saree'], sources: plat });
  check('four-platform search answers', r.status === 200, r.body && r.body.sources && r.body.sources.map((s) => s.source + ':' + (s.status === 'ok' ? s.returned : s.error.code)).join(' '));
  for (const p of ['pinterest', 'instagram', 'facebook']) {
    const found = r.status === 200 ? r.body.results.filter((x) => x.foundBy === p) : [];
    check(`${p} search returns only ${p}`, found.every((x) => x.platform === p), found.length + ' results');
  }
  check('no design returned twice', r.status === 200 && new Set(r.body.results.map((x) => x.id)).size === r.body.results.length);
  const upgraded = r.status === 200 ? r.body.results.filter((x) => x.fetchable.sizeExact === false) : [];
  check('upgraded Pinterest images point at the 736x file', upgraded.every((x) => /\/736x\//.test(x.fetchable.url) && x.fetchable.fallbackUrl), upgraded.length + ' upgraded');

  const streamRes = await fetch(B + '/api/v1/discovery/search/stream', { method: 'POST', headers: H,
    body: JSON.stringify({ clientId: 'live-stream', keywords: ['red', 'bridal', 'saree'], sources: plat }) });
  const text = await streamRes.text();
  const types = text.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6)).type);
  check('stream opens as text/event-stream', /text\/event-stream/.test(streamRes.headers.get('content-type') || ''));
  eq('stream events: start, four sources, done', types, ['start', 'source', 'source', 'source', 'source', 'done']);
  const badStream = await fetch(B + '/api/v1/discovery/search/stream', { method: 'POST', headers: H,
    body: JSON.stringify({ clientId: 'live-stream', keywords: ['x'], sources: ['tiktok'] }) });
  check('stream refuses a bad body as JSON 400', badStream.status === 400 && /json/.test(badStream.headers.get('content-type') || ''));

  section('LIVE: routing to the right pipeline');
  r = await call('/api/v1/draping/generate-catalog/women', { clientId: 'test', modelId: 'saree1' });
  check('women endpoint reached', r.status === 400 && /fullDress/.test(r.body.error));
  r = await call('/api/v1/draping/generate-catalog/men', { clientId: 'test' });
  check('men endpoint reached', r.status === 400 && /Garment image/.test(r.body.error));
  r = await call('/api/v1/draping/generate-catalog', { clientId: 'test', modelId: 'saree1', category: 'SAREE' });
  check('old-style request still routes to women', r.status === 400 && /fullDress/.test(r.body.error));
  r = await call('/api/v1/draping/generate-catalog', { clientId: 'test', category: 'men' });
  check('new-style request routes to men', r.status === 400 && /Garment image/.test(r.body.error));
  r = await call('/api/v1/draping/generate-catalog', { clientId: 'test', category: 'FORMALS' });
  check('a men garment type routes to men', r.status === 400 && /Garment image/.test(r.body.error));

  section('LIVE: failures never return 5xx');
  const codes = [];
  for (const [p_, b] of [
    ['/api/v1/discovery/search', { clientId: 't' }],
    ['/api/v1/discovery/search', { clientId: 't', category: 'NOPE', keywords: ['x'] }],
    ['/api/v1/draping/generate-catalog/women', {}],
    ['/api/v1/draping/generate-catalog/men', {}],
    ['/api/v1/draping/recommend-size', { clientId: 't' }],
    ['/api/v1/draping/cancel-job', {}]
  ]) {
    const res = await call(p_, b);
    codes.push(p_ + ' -> ' + res.status);
    check('4xx (not 5xx) for ' + p_, res.status < 500, 'HTTP ' + res.status);
  }
}

(async () => {
  const isLive = process.argv.includes('--live');
  console.log('ScaleEasy Catalog Service — test suite' + (isLive ? '  (offline + live)' : '  (offline)'));

  await offline();
  if (isLive) {
    try {
      await live();
    } catch (err) {
      failures.push('live suite crashed: ' + err.message);
      console.log('\n  live suite could not run: ' + err.message);
      console.log('  is the service running on http://localhost:4005 ?');
    }
  } else {
    console.log('\n(run `npm run test:live` to also exercise a running service)');
  }

  console.log('\n' + '='.repeat(70));
  if (failures.length) {
    console.log(failures.length + ' FAILED, ' + passed + ' passed');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('ALL ' + passed + ' CHECKS PASS');
  process.exit(0);
})();
