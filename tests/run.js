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

  section('REQUEST VALIDATION  (sources and resultFilters)');
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
  const spend = (cost) => { const err = rateLimit.charge('budget', cost); return err ? err.statusCode : 200; };
  const four = ['web', 'pinterest', 'instagram', 'facebook'];
  const seq = [];
  for (let i = 0; i < 4; i++) seq.push(spend(4)); // 16 of 20 used
  seq.push(spend(2));                             // 18
  seq.push(spend(4));                             // would be 22: refused, NOT charged
  seq.push(spend(2));                             // 20: still allowed
  seq.push(spend(1));                             // 21: refused
  seq.push(spend(0));                             // fully cached search: free even with no budget left
  eq('four calls cost four; a refused request costs nothing; a cached one is free', seq,
    [200, 200, 200, 200, 200, 429, 200, 429, 200]);
  const refusal = rateLimit.charge('budget', 1);
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

  const app = express();
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
