// =============================================================================
// shared/index.js — the one shared-state instance this process uses.
// =============================================================================
//
// Environment (all optional):
//   SHARED_STATE=off              per-server memory only (a single server, or local work)
//   SHARED_STATE_SCHEMA=se_catalog Postgres schema for the shared tables
//   SHARED_STATE_TIMEOUT_MS=1500   longest a shared-state query may take
//   JOB_CANCEL_POLL_MS=1500        how quickly a cancel reaches another server
//
const os = require('os');
const { createStore } = require('./store');
const { createRateLimiter } = require('./rateLimiter');
const { createJobRegistry } = require('./jobRegistry');
const { createCacheStore } = require('./cacheStore');

const instanceId = process.env.RENDER_INSTANCE_ID || `${os.hostname()}:${process.pid}`;
const enabled = String(process.env.SHARED_STATE || 'on').toLowerCase() !== 'off' && !!process.env.DATABASE_URL;

// The database pool is only loaded when shared state is on, so a process with
// SHARED_STATE=off (or no DATABASE_URL, as in the offline tests) never opens it.
const pool = enabled ? require('../db').pool : null;

const store = createStore({
  pool,
  schema: process.env.SHARED_STATE_SCHEMA || 'se_catalog',
  timeoutMs: Number(process.env.SHARED_STATE_TIMEOUT_MS || 1500),
  enabled
});
const rateLimiter = createRateLimiter({ store });
const jobs = createJobRegistry({ store, instanceId, pollMs: Number(process.env.JOB_CANCEL_POLL_MS || 1500) });

const SWEEP_MS = 5 * 60 * 1000;
const RETRY_INIT_MS = 60 * 1000;
let sweeper = null;
let initRetry = null;

/** Prepare shared state in the background. Never blocks or fails the boot. */
function start() {
  if (!enabled) {
    console.log(`   - Shared state: OFF (per-server memory) instance=${instanceId}`);
    return;
  }
  const attempt = () =>
    store.init().then((ok) => {
      if (ok) {
        console.log(`   - Shared state: ON (Postgres) instance=${instanceId}`);
        if (initRetry) clearInterval(initRetry);
        initRetry = null;
      } else if (!initRetry) {
        initRetry = setInterval(attempt, RETRY_INIT_MS);
        initRetry.unref();
      }
    });
  attempt();

  sweeper = setInterval(() => store.sweep().catch(() => {}), SWEEP_MS);
  sweeper.unref();
}

async function stop() {
  if (sweeper) clearInterval(sweeper);
  if (initRetry) clearInterval(initRetry);
  await jobs.shutdown();
}

/** What discovery needs, handed over without discovery importing any of this. */
function discoveryAdapter() {
  const cache = createCacheStore({ store, namespace: 'discovery' });
  return {
    consume: (bucket, cost, options) => rateLimiter.consume(`discovery:${bucket}`, cost, options),
    cacheGet: cache.get,
    cacheHasMany: cache.hasMany,
    cacheSet: cache.set
  };
}

module.exports = { instanceId, store, rateLimiter, jobs, start, stop, discoveryAdapter };
