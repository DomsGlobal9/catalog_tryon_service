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
    buildFetchable(insta, false), { url: 'https://t/2', width: 387, height: 516, from: 'thumbnailUrl' });
  const filtered = filterResults([retailer, insta, fbNoThumb]);
  eq('unviewable result dropped, others kept and flagged',
    filtered.map((f) => [f.sourceDomain, f.imageUsable, f.fetchable.from]),
    [['shop.com', true, 'imageUrl'], ['www.instagram.com', false, 'thumbnailUrl']]);
  eq('original width/height never rewritten', filtered.map((f) => [f.width, f.height]), [[1429, 2000], [1440, 1920]]);

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
  check('search returns results', r.status === 200 && r.body.results.length > 0, r.body && (r.body.results.length + ' results'));
  check('every result carries a usable fetchable url',
    r.status === 200 && r.body.results.every((x) => x.fetchable && x.fetchable.url));
  r = await call('/api/v1/discovery/search', { clientId: 'test', category: 'SAREE', designType: 'SLEEVE', keywords: ['x'] });
  check('invalid garment/area pair rejected', r.status === 400 && r.body.error.code === 'VALIDATION_ERROR');

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
