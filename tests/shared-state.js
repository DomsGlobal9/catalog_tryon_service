#!/usr/bin/env node
// =============================================================================
// tests/shared-state.js — shared state against a REAL Postgres. `npm run test:shared`
// =============================================================================
//
// Proves what the offline suite can only imitate:
//
//   1. the SQL itself: atomic limits under a race, cache expiry, job heartbeats;
//   2. two SEPARATE service processes sharing it over HTTP: one search cache,
//      one search budget, one generation budget, per-server capacity.
//
// SAFETY
//   * Uses DATABASE_URL from .env but works only inside a throwaway schema named
//     se_catalog_sstest_<random>, created here and DROPPED at the end. Nothing
//     in the real schema is read or written.
//   * Generation is exercised with GEMINI_API_KEY replaced by an invalid key, so
//     no image model is ever billed.
//   * Discovery over HTTP spends a handful of search credits and runs only when
//     TEST_SERPER_API_KEY is set (a test key - never the production one).
//
require('dotenv').config({ quiet: true });
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const { createStore } = require(path.join(SRC, 'lib/shared/store'));
const { createRateLimiter } = require(path.join(SRC, 'lib/shared/rateLimiter'));
const { createJobRegistry } = require(path.join(SRC, 'lib/shared/jobRegistry'));
const { createCacheStore } = require(path.join(SRC, 'lib/shared/cacheStore'));

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++; else failures.push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(name, a === e, a === e ? '' : `\n      got      ${a}\n      expected ${e}`);
};
const section = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log() {}, warn() {} };

const SCHEMA = 'se_catalog_sstest_' + crypto.randomBytes(4).toString('hex');
if (!/^se_catalog_sstest_[0-9a-f]{8}$/.test(SCHEMA)) throw new Error('refusing to use schema ' + SCHEMA);
if (!process.env.DATABASE_URL) { console.log('DATABASE_URL is not set - nothing to test against.'); process.exit(1); }

const newPool = () => new Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 10000 });

async function database() {
  // Two pools and two stores: two "servers" that share nothing but the database.
  const poolA = newPool(), poolB = newPool();
  const A = createStore({ pool: poolA, schema: SCHEMA, timeoutMs: 5000, log: quiet });
  const B = createStore({ pool: poolB, schema: SCHEMA, timeoutMs: 5000, log: quiet });

  try {
    section('SETUP  (tables created on boot, safely, by two servers at once)');
    const [okA, okB] = await Promise.all([A.init(), B.init()]);
    eq('both servers prepare the tables at the same moment', [okA, okB], [true, true]);
    eq('preparing again is harmless', await A.init(), true);
    const { rows: tables } = await poolA.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, [SCHEMA]);
    eq('three tables exist', tables.map((t) => t.table_name), ['active_jobs', 'shared_cache', 'shared_rate_limits']);

    section('RATE LIMIT  (one counter for every server, exact under a race)');
    const LA = createRateLimiter({ store: A }), LB = createRateLimiter({ store: B });
    const t0 = Date.now();
    const race = await Promise.all(Array.from({ length: 60 }, (_, i) =>
      (i % 2 ? LA : LB).consume('race', 1, { limit: 20, windowSec: 60 })));
    const allowed = race.filter((r) => r.allowed).length;
    eq('60 requests at once through two servers, limit 20: exactly 20 allowed', allowed, 20);
    check('every answer came from the shared counter', race.every((r) => r.shared), '');
    check('refusals say when to retry (1-60s)', race.filter((r) => !r.allowed).every((r) => r.retryAfterSec >= 1 && r.retryAfterSec <= 60),
      `took ${Date.now() - t0}ms for 60`);

    const seq = [];
    seq.push((await LA.consume('seq', 4, { limit: 5, windowSec: 60 })).allowed);
    seq.push((await LB.consume('seq', 2, { limit: 5, windowSec: 60 })).allowed);
    const refusal = await LB.consume('seq', 2, { limit: 5, windowSec: 60 });
    seq.push((await LB.consume('seq', 1, { limit: 5, windowSec: 60 })).allowed);
    eq('4 on A, then 2 on B refused (would be 6), then 1 on B allowed', seq, [true, false, true]);
    eq('the refusal reports what is used', refusal.used, 4);
    eq('a cost larger than the limit is refused and leaves no row',
      [(await LA.consume('huge', 9, { limit: 5, windowSec: 60 })).allowed,
        (await poolA.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".shared_rate_limits WHERE bucket = 'huge'`)).rows[0].n], [false, 0]);
    await LB.refund('seq', 1, { windowSec: 60 });
    eq('a refund on B frees a unit that A can spend', (await LA.consume('seq', 1, { limit: 5, windowSec: 60 })).allowed, true);

    const w1 = await LA.consume('roll', 1, { limit: 1, windowSec: 2 });
    const w2 = await LB.consume('roll', 1, { limit: 1, windowSec: 2 });
    await sleep(w2.retryAfterSec * 1000 + 150);
    const w3 = await LB.consume('roll', 1, { limit: 1, windowSec: 2 });
    eq('the window resets after Retry-After', [w1.allowed, w2.allowed, w3.allowed], [true, false, true]);

    section('SHARED CACHE');
    const CA = createCacheStore({ store: A, namespace: 'discovery' });
    const CB = createCacheStore({ store: B, namespace: 'discovery' });
    const other = createCacheStore({ store: B, namespace: 'other' });
    await CA.set('k1', { hello: 'world', n: [1, 2, 3] }, 2);
    const hit = await CB.get('k1');
    eq('written on A, read on B', hit && hit.value, { hello: 'world', n: [1, 2, 3] });
    check('expiry travels with it', hit && hit.expiresAt > Date.now() && hit.expiresAt <= Date.now() + 2500, '');
    eq('hasMany reports only what is there', [...await CB.hasMany(['k1', 'nope'])], ['k1']);
    eq('namespaces do not see each other', await other.get('k1'), null);
    await CB.set('k1', { hello: 'again' }, 60);
    eq('writing again replaces it', (await CA.get('k1')).value, { hello: 'again' });
    await CA.set('short', { x: 1 }, 1);
    await sleep(1300);
    eq('an expired entry is a miss', await CB.get('short'), null);

    const big = { results: Array.from({ length: 100 }, (_, i) => ({
      id: 'result_' + i, title: 'Red silk saree with zari border and pallu design number ' + i,
      imageUrl: 'https://example.com/images/' + i + '.jpg', thumbnailUrl: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:' + 'x'.repeat(60),
      sourceUrl: 'https://shop.example.com/products/' + i, sourceDomain: 'shop.example.com', width: 1200, height: 1600,
      platform: 'web', fetchable: { url: 'https://example.com/images/' + i + '.jpg', width: 1200, height: 1600, from: 'imageUrl' }
    })), rawCount: 100 };
    const tw = Date.now(); await CA.set('big', big, 60); const writeMs = Date.now() - tw;
    const tr = Date.now(); const bigBack = await CB.get('big'); const readMs = Date.now() - tr;
    eq('a full 100-result page survives the round trip', bigBack.value.results.length, 100);
    console.log(`      ${Math.round(JSON.stringify(big).length / 1024)}KB page: write ${writeMs}ms, read ${readMs}ms (from this machine; Render is closer)`);

    section('JOBS  (cancel on one server stops the job on another)');
    const JA = createJobRegistry({ store: A, instanceId: 'server-A', pollMs: 300, log: quiet });
    const JB = createJobRegistry({ store: B, instanceId: 'server-B', pollMs: 300, log: quiet });
    const job = await JA.register('women:acct-1:u1', 'women');
    const tc = Date.now();
    eq('B finds the job running on A', await JB.cancel('women:acct-1:u1'), true);
    while (!job.signal.aborted && Date.now() - tc < 5000) await sleep(20);
    check('A stops it within about one poll', job.signal.aborted && Date.now() - tc < 2000, `${Date.now() - tc}ms`);
    eq('a second cancel finds nothing more to stop', await JB.cancel('women:acct-1:u1'), false);
    await job.finish();
    eq('finishing removes the row', (await poolA.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".active_jobs WHERE job_key = 'women:acct-1:u1'`)).rows[0].n, 0);

    const mine = await JA.register('men:acct-2:same', 'men');
    eq('another customer with the same clientId cannot cancel it', await JB.cancel('men:acct-3:same'), false);
    eq('nor can the other pipeline', await JB.cancel('women:acct-2:same'), false);
    const hb1 = (await poolA.query(`SELECT heartbeat_at FROM "${SCHEMA}".active_jobs WHERE job_id = $1`, [mine.id])).rows[0].heartbeat_at;
    await sleep(900);
    const hb2 = (await poolA.query(`SELECT heartbeat_at FROM "${SCHEMA}".active_jobs WHERE job_id = $1`, [mine.id])).rows[0].heartbeat_at;
    check('the running server keeps sending heartbeats', new Date(hb2) > new Date(hb1), `${new Date(hb2) - new Date(hb1)}ms apart`);
    eq('not cancelled by any of that', mine.signal.aborted, false);
    await mine.finish();

    // A server that died: its row stays behind, but its heartbeat stops.
    const DEAD = createJobRegistry({ store: A, instanceId: 'server-dead', pollMs: 3_600_000, log: quiet });
    const ghost = await DEAD.register('women:acct-4:ghost', 'women');
    await poolA.query(`UPDATE "${SCHEMA}".active_jobs SET heartbeat_at = now() - interval '1 minute' WHERE job_id = $1`, [ghost.id]);
    eq('a job whose server stopped heartbeating is not reported as running', await JB.cancel('women:acct-4:ghost'), false);
    await poolA.query(`UPDATE "${SCHEMA}".active_jobs SET heartbeat_at = now() - interval '11 minutes' WHERE job_id = $1`, [ghost.id]);

    section('CLEAN-UP SWEEP');
    await poolA.query(`INSERT INTO "${SCHEMA}".shared_rate_limits VALUES ('old', now() - interval '1 hour', 1, now() - interval '1 minute')`);
    await poolA.query(`INSERT INTO "${SCHEMA}".shared_cache VALUES ('discovery:old', '{}', now() - interval '1 second')`);
    await B.sweep();
    const left = (await poolA.query(`SELECT
        (SELECT count(*)::int FROM "${SCHEMA}".shared_rate_limits WHERE bucket = 'old') AS limits,
        (SELECT count(*)::int FROM "${SCHEMA}".shared_cache WHERE cache_key = 'discovery:old') AS cache,
        (SELECT count(*)::int FROM "${SCHEMA}".active_jobs WHERE job_id = $1) AS jobs`, [ghost.id])).rows[0];
    eq('expired counters, cache entries and dead jobs are removed', left, { limits: 0, cache: 0, jobs: 0 });
    await ghost.finish();
    await JA.shutdown(); await JB.shutdown(); await DEAD.shutdown();

    section('DATABASE UNREACHABLE  (falls back, never fails a request)');
    const deadPool = new Pool({ connectionString: 'postgresql://nobody:nothing@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
    const D = createStore({ pool: deadPool, schema: SCHEMA, timeoutMs: 1000, log: quiet });
    eq('preparing the tables fails softly', await D.init(), false);
    D._setReady(true);
    const LD = createRateLimiter({ store: D });
    const td = Date.now();
    const d1 = await LD.consume('offline', 1, { limit: 2, windowSec: 60 });
    const firstMs = Date.now() - td;
    const d2 = await LD.consume('offline', 1, { limit: 2, windowSec: 60 });
    const d3 = await LD.consume('offline', 1, { limit: 2, windowSec: 60 });
    eq('limits still enforced, in memory', [d1.allowed, d2.allowed, d3.allowed, d1.shared], [true, true, false, false]);
    check('the first failure is bounded; later ones are instant', firstMs < 1500, `first ${firstMs}ms`);
    const JD = createJobRegistry({ store: D, instanceId: 'server-offline', log: quiet });
    const localJob = await JD.register('women:x:y', 'women');
    eq('a cancel on the same server still works', [await JD.cancel('women:x:y'), localJob.signal.aborted], [true, true]);
    await localJob.finish();
    await deadPool.end().catch(() => {});
  } finally {
    await poolA.end().catch(() => {});
    await poolB.end().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Two real service processes
// ─────────────────────────────────────────────────────────────────────────────
const SERVICE_KEY = process.env.SERVICE_API_KEY;
const children = [];

function startServer(name, port, extraEnv = {}) {
  const env = {
    ...process.env,
    PORT: String(port),
    RENDER_INSTANCE_ID: name,
    SHARED_STATE_SCHEMA: SCHEMA,
    DB_POOL_MAX: '3',
    GEMINI_API_KEY: 'invalid-test-key-no-billing',
    GENERATION_RATE_LIMIT_PER_HOUR: '2',
    DISCOVERY_RATE_LIMIT_PER_MIN: '6',
    SERPER_TIMEOUT_MS: '15000',
    SERPER_API_KEY: process.env.TEST_SERPER_API_KEY || '',
    ...extraEnv
  };
  const child = spawn(process.execPath, ['src/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  children.push(child);
  return { name, base: `http://127.0.0.1:${port}`, child, logs };
}

async function waitReady(server, needle) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (server.logs.join('').includes(needle)) return true;
    await sleep(100);
  }
  return false;
}

function call(server, p, { body, account, method = 'POST' } = {}) {
  return fetch(server.base + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': SERVICE_KEY,
      ...(account ? { 'x-gateway-client-id': account } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

async function readAll(res, ms = 60000) {
  const timer = setTimeout(() => res.body.cancel().catch(() => {}), ms);
  try { return await res.text(); } catch { return ''; } finally { clearTimeout(timer); }
}

async function servers() {
  const A = startServer('server-A', 4031);
  const B = startServer('server-B', 4032);
  const readyA = await waitReady(A, 'Shared state: ON');
  const readyB = await waitReady(B, 'Shared state: ON');
  section('TWO SERVICE PROCESSES  (same database, nothing else in common)');
  check('both boot with shared state on', readyA && readyB, readyA && readyB ? '' : '\n' + A.logs.join('') + B.logs.join(''));

  const hA = await (await fetch(A.base + '/health')).json();
  const hB = await (await fetch(B.base + '/health')).json();
  eq('/health says which server answered', [hA.status, hA.instance, hB.instance], ['OK', 'server-A', 'server-B']);

  section('GENERATION BUDGET ACROSS SERVERS  (limit 2/hour, invalid model key: nothing billed)');
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const gen = (server, account, clientId) => call(server, '/api/v1/draping/generate-catalog/men', {
    account, body: { clientId, full: PNG, sizes: ['M'], categoryGroup: 'TOP_WEAR' }
  });
  const g1 = await gen(A, 'cust-gen', 'phone-1'); await readAll(g1);
  const g2 = await gen(B, 'cust-gen', 'laptop-7'); await readAll(g2);
  const g3 = await gen(A, 'cust-gen', 'tablet-3');
  const g3body = await g3.json().catch(() => ({}));
  eq('generation 1 on A and 2 on B are admitted (they stream)', [g1.status, g2.status], [200, 200]);
  eq('generation 3 on A is refused: the customer used 2 across both servers', [g3.status, !!g3.headers.get('retry-after')], [429, true]);
  check('with a message saying when', /per hour/.test(g3body.error || ''), g3body.error);
  const g4 = await gen(B, 'cust-other', 'phone-1'); await readAll(g4);
  eq('another customer is unaffected', g4.status, 200);
  const g5 = await gen(B, null, 'direct-caller'); await readAll(g5);
  eq('a direct call without the gateway header has its own budget', g5.status, 200);

  section('CANCEL ACROSS SERVERS  (over HTTP)');
  const none = await (await call(B, '/api/v1/draping/cancel-job', { account: 'cust-x', body: { clientId: 'nobody', pipeline: 'men' } })).json();
  eq('cancelling when nothing runs says so', none.message, 'No active generation found.');
  const { rows: leftJobs } = await (async () => {
    const p = newPool();
    try { return await p.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".active_jobs`); } finally { await p.end(); }
  })();
  eq('every finished generation removed its job row', leftJobs[0].n, 0);

  if (!process.env.TEST_SERPER_API_KEY) {
    console.log('\n  (discovery across servers skipped: set TEST_SERPER_API_KEY to a test key to run it)');
    return;
  }

  section('DISCOVERY ACROSS SERVERS  (real search provider, test key)');
  // The database section left its own test entries in this table; start empty so
  // the count below only sees what server A writes.
  const wipe = newPool();
  try { await wipe.query(`DELETE FROM "${SCHEMA}".shared_cache`); } finally { await wipe.end(); }
  const s1 = await call(A, '/api/v1/discovery/search', { account: 'cust-d', body: { clientId: 'u1', keywords: ['mirror', 'work', 'lehenga'], sources: ['web', 'pinterest'] } });
  const b1 = await s1.json();
  // The shared write is deliberately not on the response path. Wait until it has
  // landed (and report how long that took) rather than guessing with a fixed pause.
  const watch = newPool();
  const tWrite = Date.now();
  let landed = 0;
  try {
    while (Date.now() - tWrite < 10000) {
      landed = (await watch.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".shared_cache WHERE cache_key LIKE 'discovery:%'`)).rows[0].n;
      if (landed >= 2) break;
      await sleep(100);
    }
  } finally {
    await watch.end();
  }
  check('A saved exactly its two platforms to the shared cache after answering', landed === 2, `${landed} entries, visible after ~${Date.now() - tWrite}ms`);
  const s2 = await call(B, '/api/v1/discovery/search', { account: 'cust-e', body: { clientId: 'u9', keywords: ['mirror', 'work', 'lehenga'], sources: ['web', 'pinterest'] } });
  const b2 = await s2.json();
  eq('searched on A, fresh', [s1.status, b1.cached], [200, false]);
  eq('the same search on B comes from the shared cache: no second provider bill', [s2.status, b2.cached], [200, true]);
  const sharedLogs = [...A.logs, ...B.logs].join('').split('\n').filter((l) => /\[shared\]/.test(l));
  if (sharedLogs.length) console.log('      server shared-state log:\n      ' + sharedLogs.join('\n      '));
  eq('...and returns the same designs', b2.results.map((r) => r.id), b1.results.map((r) => r.id));

  // Budget 6 calls/min per customer, shared. cust-d already spent 2 above.
  const q = (server, clientId, words, sources) => call(server, '/api/v1/discovery/search', { account: 'cust-d', body: { clientId, keywords: words, sources } });
  const d1 = await q(B, 'u2', ['kalamkari', 'blouse'], ['web', 'pinterest', 'instagram']); // 2 + 3 = 5
  const d2 = await q(A, 'u3', ['ikat', 'dupatta'], ['web', 'pinterest']);                 // would be 7
  const d2body = await d2.json();
  const d3 = await q(A, 'u4', ['ikat', 'dupatta'], ['web']);                              // 6
  eq('budget shared across servers and clientIds: 5 used, a 2-call search refused, a 1-call search allowed',
    [d1.status, d2.status, d3.status], [200, 429, 200]);
  check('refusal explains itself', /provider call/.test((d2body.error && d2body.error.message) || ''), d2body.error && d2body.error.message);
  const d4 = await q(B, 'u5', ['mirror', 'work', 'lehenga'], ['web', 'pinterest']);
  eq('out of budget, a search already in the shared cache still works', d4.status, 200);

  const stream = await call(B, '/api/v1/discovery/search/stream', { account: 'cust-d', body: { clientId: 'u6', keywords: ['mirror', 'work', 'lehenga'], sources: ['web', 'pinterest'] } });
  const text = await readAll(stream, 30000);
  const types = text.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6)));
  eq('the stream on B serves both platforms from the shared cache', types.filter((e) => e.type === 'source').map((e) => e.cached), [true, true]);

  section('A SERVER WITHOUT ITS DATABASE  (keeps working on its own)');
  const C = startServer('server-C', 4033, { DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none', DB_POOL_CONNECT_MS: '500' });
  const readyC = await waitReady(C, 'per-server mode');
  check('boots and says it is in per-server mode', readyC, readyC ? '' : C.logs.join('').slice(-800));
  const hc = await fetch(C.base + '/health');
  eq('health is still OK', hc.status, 200);
  const sc = await call(C, '/api/v1/discovery/search', { account: 'cust-c', body: { clientId: 'u1', keywords: ['mirror', 'work', 'lehenga'], sources: ['web'] } });
  eq('discovery still answers', sc.status, 200);
}

(async () => {
  console.log(`Shared state test suite  (throwaway schema ${SCHEMA})`);
  try {
    await database();
    if (process.argv.includes('--servers')) await servers();
    else console.log('\n(add --servers to also run two real service processes against it)');
  } catch (err) {
    failures.push('crashed: ' + err.message);
    console.log('\n  crashed: ' + (err.stack || err.message));
  } finally {
    for (const c of children) c.kill();
    const pool = newPool();
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      const gone = (await pool.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [SCHEMA])).rowCount === 0;
      console.log(`\n  throwaway schema ${SCHEMA} ${gone ? 'dropped' : 'NOT dropped - remove it by hand'}`);
    } finally {
      await pool.end();
    }
  }

  console.log('\n' + '='.repeat(70));
  if (failures.length) {
    console.log(`${failures.length} FAILED, ${passed} passed`);
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log(`ALL ${passed} CHECKS PASS`);
  process.exit(0);
})();
