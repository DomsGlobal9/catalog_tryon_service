// =============================================================================
// store.js — state shared by every running copy of this service.
// =============================================================================
//
// With one server, counters and job lists can live in memory. With two or more
// behind a load balancer they cannot: each copy would count limits on its own
// (so a customer gets double the allowance), and a "cancel" landing on the copy
// that is not running the job would find nothing to cancel.
//
// The shared state lives in the Postgres database the service already uses, in
// three small tables. No extra infrastructure to run or pay for.
//
// FAILING SOFT IS THE CONTRACT. The database is a helper here, never a
// dependency: if it is slow or down, every caller falls back to its own
// in-memory behaviour and the service keeps answering. After a failure the store
// stays "down" for a short cooldown, so an outage costs one slow query rather than
// one slow query per request.
//
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

class SharedStoreUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'SharedStoreUnavailable';
  }
}

/**
 * @param {Object}  options
 * @param {import('pg').Pool} options.pool
 * @param {string}  options.schema       Postgres schema holding the tables.
 * @param {number}  [options.timeoutMs]  Longest any one query may take.
 * @param {number}  [options.cooldownMs] How long to stop trying after a failure.
 * @param {boolean} [options.enabled]    false = always use in-memory fallbacks.
 */
function createStore({ pool, schema, timeoutMs = 1500, cooldownMs = 15000, enabled = true, log = console }) {
  if (!IDENTIFIER.test(schema)) throw new Error(`Invalid shared state schema name: ${schema}`);
  const s = `"${schema}"`;
  const t = {
    rateLimits: `${s}.shared_rate_limits`,
    cache: `${s}.shared_cache`,
    jobs: `${s}.active_jobs`
  };

  let ready = false;
  let downUntil = 0;
  let lastError = null;
  let consecutiveFailures = 0;

  // One slow query (a cold connection to a distant database takes ~600ms before
  // the query even starts) must not switch sharing off for everyone on this
  // server. Two failures in a row do.
  const FAILURES_BEFORE_COOLDOWN = 2;

  function recordFailure(err) {
    lastError = err.message;
    consecutiveFailures += 1;
    if (consecutiveFailures < FAILURES_BEFORE_COOLDOWN) {
      log.warn(`[shared] query failed (${consecutiveFailures}/${FAILURES_BEFORE_COOLDOWN}), falling back for this request: ${err.message}`);
      return;
    }
    if (!downUntil || Date.now() >= downUntil) {
      log.warn(`[shared] database unavailable, using per-server memory for ${Math.round(cooldownMs / 1000)}s: ${err.message}`);
    }
    downUntil = Date.now() + cooldownMs;
  }

  /** Run one query, bounded in time. Throws SharedStoreUnavailable on any failure. */
  async function query(text, values) {
    if (!enabled) throw new SharedStoreUnavailable('shared state is switched off');
    if (!ready) throw new SharedStoreUnavailable('shared state is not ready yet');
    if (Date.now() < downUntil) throw new SharedStoreUnavailable(`shared state cooling down after: ${lastError}`);

    let timer;
    try {
      const result = await Promise.race([
        pool.query(text, values),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`query took longer than ${timeoutMs}ms`)), timeoutMs);
        })
      ]);
      if (downUntil) log.log('[shared] database reachable again, shared state restored');
      downUntil = 0;
      lastError = null;
      consecutiveFailures = 0;
      return result;
    } catch (err) {
      recordFailure(err);
      throw new SharedStoreUnavailable(err.message);
    } finally {
      clearTimeout(timer);
    }
  }

  // Column types and index names follow Prisma's conventions, so these tables
  // match the models in prisma/schema.prisma and `prisma db push` sees no drift.
  const DDL = [
    `CREATE TABLE IF NOT EXISTS ${t.rateLimits} (
       bucket       text           NOT NULL,
       window_start timestamptz(6) NOT NULL,
       used         integer        NOT NULL,
       expires_at   timestamptz(6) NOT NULL,
       CONSTRAINT shared_rate_limits_pkey PRIMARY KEY (bucket, window_start))`,
    `CREATE INDEX IF NOT EXISTS shared_rate_limits_expires_at_idx ON ${t.rateLimits} (expires_at)`,
    `CREATE TABLE IF NOT EXISTS ${t.cache} (
       cache_key  text           NOT NULL,
       value      json           NOT NULL,
       expires_at timestamptz(6) NOT NULL,
       CONSTRAINT shared_cache_pkey PRIMARY KEY (cache_key))`,
    `CREATE INDEX IF NOT EXISTS shared_cache_expires_at_idx ON ${t.cache} (expires_at)`,
    `CREATE TABLE IF NOT EXISTS ${t.jobs} (
       job_id           text           NOT NULL,
       job_key          text           NOT NULL,
       pipeline         text           NOT NULL,
       instance_id      text           NOT NULL,
       cancel_requested boolean        NOT NULL DEFAULT false,
       started_at       timestamptz(6) NOT NULL DEFAULT now(),
       heartbeat_at     timestamptz(6) NOT NULL DEFAULT now(),
       CONSTRAINT active_jobs_pkey PRIMARY KEY (job_id))`,
    `CREATE INDEX IF NOT EXISTS active_jobs_job_key_idx ON ${t.jobs} (job_key)`
  ];

  /**
   * Create the tables if they are missing. Never throws: on failure the service
   * runs in per-server mode and this is retried later.
   * @returns {Promise<boolean>} whether shared state is now usable.
   */
  async function init() {
    if (!enabled) return false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const found = await pool.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [schema]);
        if (!found.rowCount) await pool.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
        for (const statement of DDL) await pool.query(statement);
        ready = true;
        downUntil = 0;
        return true;
      } catch (err) {
        // Two servers booting at the same moment can race on CREATE TABLE IF NOT
        // EXISTS and one gets a duplicate-type error. The second attempt sees the
        // table and succeeds.
        lastError = err.message;
        if (attempt === 2) log.warn(`[shared] could not prepare shared state tables, per-server mode: ${err.message}`);
      }
    }
    return false;
  }

  /** Remove expired rows. Safe to run from every server at once. */
  async function sweep() {
    await query(`DELETE FROM ${t.rateLimits} WHERE expires_at < now()`);
    await query(`DELETE FROM ${t.cache} WHERE expires_at < now()`);
    // A job whose server stopped sending heartbeats has died with that server.
    await query(`DELETE FROM ${t.jobs} WHERE heartbeat_at < now() - interval '10 minutes'`);
  }

  function status() {
    return {
      enabled,
      ready,
      healthy: enabled && ready && Date.now() >= downUntil,
      lastError
    };
  }

  return { query, init, sweep, status, tables: t, _setReady: (v) => { ready = v; } };
}

module.exports = { createStore, SharedStoreUnavailable };
