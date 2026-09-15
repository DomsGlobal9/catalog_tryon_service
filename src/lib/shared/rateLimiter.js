// =============================================================================
// rateLimiter.js — fixed-window counters shared by every server.
// =============================================================================
//
// consume(bucket, cost) either spends `cost` units from the bucket's current
// window or refuses without spending anything. The check and the spend are one
// SQL statement, so two servers serving the same customer at the same instant
// can never both squeeze through the last unit.
//
// Windows are aligned to the database clock (every server agrees on when a
// minute starts, whatever its own clock says).
//
// If the database is unavailable the same rules are applied in this server's
// memory. Limits are then per server until it recovers - more generous, never
// broken.
//
const { SharedStoreUnavailable } = require('./store');

function createRateLimiter({ store, now = Date.now }) {
  /** @type {Map<string, { windowStart: number, used: number }>} */
  const local = new Map();

  function consumeLocal(bucket, cost, limit, windowSec) {
    const windowMs = windowSec * 1000;
    const at = now();
    const windowStart = Math.floor(at / windowMs) * windowMs;

    if (local.size > 10_000) {
      for (const [key, entry] of local) if (entry.windowStart < windowStart) local.delete(key);
    }

    let entry = local.get(bucket);
    if (!entry || entry.windowStart !== windowStart) {
      entry = { windowStart, used: 0 };
      local.set(bucket, entry);
    }

    const retryAfterSec = Math.max(1, Math.ceil((windowStart + windowMs - at) / 1000));
    if (entry.used + cost > limit) {
      return { allowed: false, used: entry.used, limit, retryAfterSec, shared: false };
    }
    entry.used += cost;
    return { allowed: true, used: entry.used, limit, retryAfterSec, shared: false };
  }

  const SQL = `
    WITH w AS (
      SELECT to_timestamp(floor(extract(epoch FROM clock_timestamp()) / $3::int) * $3::int) AS start
    ), spent AS (
      INSERT INTO ${store.tables.rateLimits} AS r (bucket, window_start, used, expires_at)
      SELECT $1::text, w.start, $2::int, w.start + ($3::int * 2) * interval '1 second' FROM w
      WHERE $2::int <= $4::int
      ON CONFLICT (bucket, window_start)
        DO UPDATE SET used = r.used + EXCLUDED.used
        WHERE r.used + EXCLUDED.used <= $4::int
      RETURNING r.used
    )
    SELECT
      (SELECT used FROM spent) AS used_after,
      (SELECT r.used FROM ${store.tables.rateLimits} r, w WHERE r.bucket = $1::text AND r.window_start = w.start) AS used_before,
      GREATEST(1, ceil(extract(epoch FROM (SELECT start FROM w)) + $3::int - extract(epoch FROM clock_timestamp())))::int AS retry_after`;

  /**
   * @param {string} bucket
   * @param {number} cost       Units this request needs. 0 is always allowed.
   * @param {Object} options
   * @param {number} options.limit      Units allowed per window.
   * @param {number} options.windowSec  Window length.
   * @returns {Promise<{ allowed: boolean, used: number, limit: number, retryAfterSec: number, shared: boolean }>}
   */
  async function consume(bucket, cost, { limit, windowSec }) {
    if (!(cost > 0)) return { allowed: true, used: 0, limit, retryAfterSec: 0, shared: false };

    try {
      const { rows } = await store.query(SQL, [bucket, cost, windowSec, limit]);
      const row = rows[0];
      if (row.used_after !== null && row.used_after !== undefined) {
        return { allowed: true, used: Number(row.used_after), limit, retryAfterSec: row.retry_after, shared: true };
      }
      return { allowed: false, used: Number(row.used_before || 0), limit, retryAfterSec: row.retry_after, shared: true };
    } catch (err) {
      if (!(err instanceof SharedStoreUnavailable)) throw err;
      return consumeLocal(bucket, cost, limit, windowSec);
    }
  }

  /**
   * Give back units spent in the current window, for work that was admitted by
   * the budget but then refused for another reason. Best effort.
   */
  async function refund(bucket, cost, { windowSec }) {
    if (!(cost > 0)) return;
    try {
      await store.query(
        `UPDATE ${store.tables.rateLimits} SET used = GREATEST(0, used - $2::int)
          WHERE bucket = $1::text
            AND window_start = to_timestamp(floor(extract(epoch FROM clock_timestamp()) / $3::int) * $3::int)`,
        [bucket, cost, windowSec]
      );
    } catch (err) {
      if (!(err instanceof SharedStoreUnavailable)) throw err;
      const entry = local.get(bucket);
      if (entry) entry.used = Math.max(0, entry.used - cost);
    }
  }

  return { consume, refund, _resetLocal: () => local.clear() };
}

module.exports = { createRateLimiter };
