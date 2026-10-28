#!/usr/bin/env node
// =============================================================================
// tests/billing.js — per-run billing records, against a LOCAL Postgres.
// =============================================================================
//
//   BILLING_TEST_DATABASE_URL=postgresql://postgres:localpw@localhost:55433/scaleezy_gateway_local \
//     node tests/billing.js            run the checks (exit 1 on any failure)
//     node tests/billing.js --serve 4995
//                                      only start the stubbed service, for the
//                                      Gateway's end-to-end billing test
//
// WHAT IS STUBBED, AND WHY
//   The image model is replaced, inside this process only, by a stand-in that
//   COUNTS every generation it is asked for and streams four fake views (or
//   fails / stalls on request). Everything else is the real service: the real
//   routes, the real admission checks, the real database writes. So these
//   checks prove what is charged, without spending a rupee of AI. The real
//   generation is covered by the existing suites; one real paid run to prove a
//   live delivery writes exactly one row is left for the owner to approve.
//
//   What the stand-in does is chosen by the garment string the test sends:
//     "stub:ok:<anything>"            four views, then done
//     "stub:fail-after:<n>:<any>"     n views, then a provider error
//     "stub:slow:<ms>:<any>"          four views, <ms> apart (cancellable)
//
// SAFETY
//   * Refuses to run unless the database is on localhost. It never reads .env
//     for the database: DATABASE_URL is set from BILLING_TEST_DATABASE_URL
//     before the service loads, so dotenv cannot replace it.
//   * GEMINI_API_KEY is replaced with an invalid value, so even a path that
//     escaped the stand-in could not bill the image model.
//
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const DB_URL = process.env.BILLING_TEST_DATABASE_URL;
if (!DB_URL) {
  console.error('Set BILLING_TEST_DATABASE_URL to a LOCAL test database. Refusing to run.');
  process.exit(2);
}
const dbHost = new URL(DB_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(dbHost)) {
  console.error(`BILLING_TEST_DATABASE_URL points at ${dbHost}, not localhost. Refusing to run.`);
  process.exit(2);
}

const serveIdx = process.argv.indexOf('--serve');
const SERVE_PORT = serveIdx > -1 ? Number(process.argv[serveIdx + 1]) : 0;

process.env.DATABASE_URL = DB_URL;
process.env.GEMINI_API_KEY = 'billing-test-invalid-key-never-valid';
process.env.SERVICE_API_KEY = process.env.BILLING_TEST_SERVICE_KEY || crypto.randomBytes(24).toString('hex');
process.env.SERPER_API_KEY = 'billing-test-invalid-key-never-sent';
process.env.GENERATION_RATE_LIMIT_PER_HOUR = '0';
process.env.SSE_HEARTBEAT_MS = '60000';
process.env.JOB_CANCEL_POLL_MS = '200';
process.env.PORT = String(SERVE_PORT || 4994);

// BILLING_TEST_SRC points the same checks at another copy of src/ - used once to
// prove they FAIL on the code from before billing (git archive HEAD~ src).
const SRC = process.env.BILLING_TEST_SRC || path.join(__dirname, '..', 'src');

// ── The stand-in for the image model ───────────────────────────────────────
const stub = { generations: 0, imageCalls: 0 };
const aiService = require(path.join(SRC, 'services/catalogAiService'));
aiService.generate4ViewCatalog = async function stubGenerate(inputs, _bases, onProgress, signal) {
  stub.generations += 1;
  const spec = String(inputs.fullDress || '');
  const [, mode, arg] = spec.split(':');
  const failAfter = mode === 'fail-after' ? Number(arg) : Infinity;
  const gapMs = mode === 'slow' ? Number(arg) : 5;
  const out = {};
  for (const view of ['front', 'back', 'side', 'sitting']) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, gapMs);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('AbortError: Generation cancelled by client')); }, { once: true });
    });
    if (signal && signal.aborted) throw new Error('AbortError: Generation cancelled by client');
    if (Object.keys(out).length >= failAfter) throw new Error('Gemini API Error: HTTP 500 - stub failure');
    stub.imageCalls += 1;
    out[view] = 'data:image/jpeg;base64,AAAA';
    if (onProgress) onProgress({ view, image: out[view] });
  }
  return out;
};

const { pool } = require(path.join(SRC, 'lib/db'));

async function ensureModel() {
  await pool.query(`
    INSERT INTO se_catalog.draping_models (id, name, front_base_url, back_base_url, sitting_base_url, side_base_url, updated_at)
    VALUES ('saree1', 'Billing test model', 'https://example.invalid/f.jpg', 'https://example.invalid/b.jpg',
            'https://example.invalid/s.jpg', 'https://example.invalid/d.jpg', now())
    ON CONFLICT (id) DO NOTHING`);
}

function startService() {
  require(path.join(SRC, 'index.js'));
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const poll = () => http.get(`http://127.0.0.1:${process.env.PORT}/health`, (r) => { r.resume(); resolve(); })
      .on('error', () => (Date.now() > deadline ? reject(new Error('service did not start')) : setTimeout(poll, 150)));
    poll();
  });
}

// ── --serve: just the stubbed service, plus a counter for the Gateway test ──
if (SERVE_PORT) {
  (async () => {
    await ensureModel();
    await startService();
    http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(stub));
    }).listen(SERVE_PORT + 1, '127.0.0.1');
    console.log(`[billing-test] stubbed service on ${SERVE_PORT}, generation counter on ${SERVE_PORT + 1}`);
  })().catch((e) => { console.error(e); process.exit(1); });
  return;
}

// ── The checks ─────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++; else failures.push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  check(name, a === e, a === e ? '' : `\n      got      ${a}\n      expected ${e}`);
};
const section = (t) => console.log(`\n${t}`);

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const KEY = process.env.SERVICE_API_KEY;
const RUN = crypto.randomBytes(4).toString('hex');

/** A request as the Gateway sends it: service key, client id, request id. */
function gatewayHeaders(account, requestId = crypto.randomUUID()) {
  const h = { 'content-type': 'application/json', 'x-api-key': KEY, 'x-request-id': requestId };
  if (account) h['x-gateway-client-id'] = account;
  return h;
}

async function generate(account, body, { requestId, signal, headers } = {}) {
  const res = await fetch(`${BASE}/api/v1/draping/generate-catalog/women`, {
    method: 'POST',
    headers: headers || gatewayHeaders(account, requestId),
    body: JSON.stringify({ modelId: 'saree1', category: 'SAREE', ...body }),
    signal
  });
  const text = await res.text();
  const events = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  let json = null;
  if (!events.length) { try { json = JSON.parse(text); } catch { /* not JSON */ } }
  return { status: res.status, events, json, types: events.map((e) => e.type) };
}

async function rows(account) {
  const r = await pool.query(
    `SELECT kind, request_key, colour_name, colour_hex, garment_ref, views, gateway_request_id
       FROM se_catalog.billable_runs WHERE client_id = $1 ORDER BY delivered_at, id`, [account]);
  return r.rows;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await ensureModel();
  await startService();

  section('A FULLY DELIVERED CATALOG  → exactly one CATALOG row');
  {
    const acct = `acct-${RUN}-a`;
    const rid = crypto.randomUUID();
    const before = stub.generations;
    const r = await generate(acct, { clientId: 'shop-1', saree: 'stub:ok:red-banarasi' }, { requestId: rid });
    eq('stream: STATUS, four VIEW_READY, COMPLETE', r.types, ['STATUS', 'VIEW_READY', 'VIEW_READY', 'VIEW_READY', 'VIEW_READY', 'COMPLETE']);
    eq('the model was asked once', stub.generations - before, 1);
    eq('one row, CATALOG, 4 views, keyed on the Gateway request id, garment hashed', await rows(acct), [{
      kind: 'CATALOG', request_key: `req:${rid}`, colour_name: null, colour_hex: null,
      garment_ref: sha('stub:ok:red-banarasi'), views: 4, gateway_request_id: rid
    }]);
  }

  section('A COLOUR RUN  → exactly one COLOUR_VARIANT row, with its colour');
  {
    const acct = `acct-${RUN}-b`;
    const r = await generate(acct, { clientId: 'shop-1', saree: 'stub:ok:red-banarasi', jobId: 'blue-1', color: { name: 'Royal Blue', hex: '#2745A8' } });
    check('stream completed', r.types.at(-1) === 'COMPLETE', r.types.join(','));
    eq('one COLOUR_VARIANT row keyed on the caller jobId, same garment as the plain run', (await rows(acct)).map(({ gateway_request_id, ...x }) => x), [{
      kind: 'COLOUR_VARIANT', request_key: 'job:blue-1', colour_name: 'Royal Blue', colour_hex: '#2745A8',
      garment_ref: sha('stub:ok:red-banarasi'), views: 4
    }]);
    const hexOnly = await generate(acct, { clientId: 'shop-1', saree: 'stub:ok:red-banarasi', color: '#0F5132' });
    check('hex-only colour completed', hexOnly.types.at(-1) === 'COMPLETE');
    const last = (await rows(acct)).at(-1) || {};
    eq('hex-only colour is named for the bill', [last.kind, last.colour_name, last.colour_hex], ['COLOUR_VARIANT', 'Bottle Green', '#0F5132']);
  }

  section('FAILED, PARTIAL, CANCELLED, DISCONNECTED  → no row');
  {
    const acct = `acct-${RUN}-c`;
    const failed = await generate(acct, { clientId: 'shop-1', saree: 'stub:fail-after:0:x' });
    eq('failed before any view: ERROR event', failed.types, ['STATUS', 'ERROR']);
    const partial = await generate(acct, { clientId: 'shop-1', saree: 'stub:fail-after:3:x' });
    eq('partial (3 of 4 views, then an error): three views then ERROR', partial.types, ['STATUS', 'VIEW_READY', 'VIEW_READY', 'VIEW_READY', 'ERROR']);

    // Cancelled from the cancel route while running.
    const running = generate(acct, { clientId: 'shop-cancel', saree: 'stub:slow:400:x' });
    await sleep(600);
    const cancel = await fetch(`${BASE}/api/v1/draping/cancel-job/women`, {
      method: 'POST', headers: gatewayHeaders(acct), body: JSON.stringify({ clientId: 'shop-cancel' })
    }).then((r) => r.json());
    check('cancel route found the job', cancel.success === true, JSON.stringify(cancel));
    const cancelled = await running;
    check('cancelled stream ends with ERROR CANCELLED', cancelled.events.at(-1)?.code === 'CANCELLED', JSON.stringify(cancelled.events.at(-1)));

    // Replaced by a newer job for the same clientId (the zombie killer).
    const first = generate(acct, { clientId: 'shop-replace', saree: 'stub:slow:400:x' });
    await sleep(500);
    const second = generate(acct, { clientId: 'shop-replace', saree: 'stub:ok:y', jobId: `replace-${RUN}` });
    const [firstR, secondR] = await Promise.all([first, second]);
    check('replaced job ends CANCELLED', firstR.events.at(-1)?.code === 'CANCELLED');
    check('the replacing job completes', secondR.types.at(-1) === 'COMPLETE');

    // The caller (or the Gateway's 90 s timeout) hangs up mid-stream.
    const ac = new AbortController();
    const hungUp = generate(acct, { clientId: 'shop-hangup', saree: 'stub:slow:400:x' }, { signal: ac.signal }).catch((e) => e);
    await sleep(600);
    ac.abort();
    await hungUp;
    await sleep(1200);

    eq('only the replacing job was charged: one row', (await rows(acct)).map((r) => r.request_key), [`job:replace-${RUN}`]);
  }

  section('THE SAME REQUEST RETRIED  → still one row, and no second AI run');
  {
    const acct = `acct-${RUN}-d`;
    const jobId = `retry-${RUN}`;
    const failedFirst = await generate(acct, { clientId: 'shop-1', saree: 'stub:fail-after:2:x', jobId });
    check('first attempt failed', failedFirst.types.at(-1) === 'ERROR');
    eq('a failed attempt is not charged', (await rows(acct)).length, 0);
    const ok = await generate(acct, { clientId: 'shop-1', saree: 'stub:ok:x', jobId });
    check('the retry after a failure is delivered', ok.types.at(-1) === 'COMPLETE');
    eq('…and charged once', (await rows(acct)).length, 1);

    const before = stub.generations;
    const again = await generate(acct, { clientId: 'shop-1', saree: 'stub:ok:x', jobId });
    eq('retry of a delivered jobId: 409 ALREADY_DELIVERED', [again.status, again.json?.code], [409, 'ALREADY_DELIVERED']);
    eq('…refused before any AI work', stub.generations - before, 0);
    eq('…still one row', (await rows(acct)).length, 1);

    const otherAcct = `acct-${RUN}-d2`;
    const sameIdOtherClient = await generate(otherAcct, { clientId: 'shop-1', saree: 'stub:ok:x', jobId });
    check('the same jobId from ANOTHER client is its own run', sameIdOtherClient.types.at(-1) === 'COMPLETE');
    eq('…charged to that client', (await rows(otherAcct)).length, 1);

    // Same Gateway request id delivered twice (no jobId): the unique key holds.
    const acct2 = `acct-${RUN}-d3`;
    const rid = crypto.randomUUID();
    await generate(acct2, { clientId: 'shop-1', saree: 'stub:ok:x' }, { requestId: rid });
    await generate(acct2, { clientId: 'shop-2', saree: 'stub:ok:x' }, { requestId: rid });
    eq('the same Gateway request id twice: one row', (await rows(acct2)).length, 1);
  }

  section('TWO RUNS AT ONCE FROM ONE CLIENT  → two rows');
  {
    const acct = `acct-${RUN}-e`;
    const [a, b] = await Promise.all([
      generate(acct, { clientId: 'counter-1', saree: 'stub:slow:50:a' }),
      generate(acct, { clientId: 'counter-2', saree: 'stub:slow:50:b', color: 'Bottle Green' })
    ]);
    check('both completed', a.types.at(-1) === 'COMPLETE' && b.types.at(-1) === 'COMPLETE');
    eq('two rows, one of each kind', (await rows(acct)).map((r) => r.kind).sort(), ['CATALOG', 'COLOUR_VARIANT']);
  }

  section('NOT BILLABLE  → no row');
  {
    const before = stub.generations;
    const bad = await generate(`acct-${RUN}-f`, { clientId: 'shop-1', saree: 'stub:ok:x', jobId: 'has spaces!' });
    eq('a malformed jobId: 400 INVALID_JOB_ID', [bad.status, bad.json?.code], [400, 'INVALID_JOB_ID']);
    eq('…before any AI work', stub.generations - before, 0);
    const direct = await generate(null, { clientId: 'own-tool', saree: 'stub:ok:x' }, { headers: { 'content-type': 'application/json', 'x-api-key': KEY } });
    check('a direct call (ScaleEzy\'s own, no Gateway client) is delivered', direct.types.at(-1) === 'COMPLETE');
    const any = await pool.query(`SELECT count(*)::int AS n FROM se_catalog.billable_runs WHERE drape_job_id = $1`, [direct.events.at(-1).jobId]);
    eq('…and not charged', any.rows[0].n, 0);
  }

  section('GET /internal/billing/usage  (the Gateway\'s view)');
  {
    const acct = `acct-${RUN}-b`;
    const from = new Date(Date.now() - 3600e3).toISOString();
    const to = new Date(Date.now() + 3600e3).toISOString();
    const get = (qs, headers = { 'x-api-key': KEY }) => fetch(`${BASE}/internal/billing/usage?${qs}`, { headers });
    const r = await get(`clientId=${acct}&from=${from}&to=${to}`);
    const body = await r.json();
    eq('200 with totals per kind', [r.status, body.totals], [200, { CATALOG: 0, COLOUR_VARIANT: 2 }]);
    eq('grouped under the one garment', body.garments.map((g) => [g.colourVariants, g.colours]), [[2, ['Royal Blue', 'Bottle Green']]]);
    eq('run list in delivery order', body.runs.map((x) => x.requestKey.split(':')[0]), ['job', 'req']);
    const all = await (await get(`from=${from}&to=${to}`)).json();
    check('no clientId: every client', new Set(all.runs.map((x) => x.clientId)).size >= 5);
    eq('without the service key: 401', (await get(`clientId=${acct}&from=${from}&to=${to}`, {})).status, 401);
    eq('a request the Gateway proxied for a third party: 404', (await get(`clientId=${acct}&from=${from}&to=${to}`, { 'x-api-key': KEY, 'x-gateway-client-id': 'someone' })).status, 404);
    eq('missing range: 400', (await get(`clientId=${acct}`)).status, 400);
    eq('range backwards: 400', (await get(`clientId=${acct}&from=${to}&to=${from}`)).status, 400);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log('FAILED:\n  - ' + failures.join('\n  - '));
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
