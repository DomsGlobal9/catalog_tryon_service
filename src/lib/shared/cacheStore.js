// =============================================================================
// cacheStore.js — a key/value cache with expiry, shared by every server.
// =============================================================================
//
// Used by design discovery so a search answered by one server is free on the
// others too. Every method throws SharedStoreUnavailable when the database
// cannot be used; callers treat that as a cache miss.
//
function createCacheStore({ store, namespace }) {
  const k = (key) => `${namespace}:${key}`;

  /** @returns {Promise<{ value: any, expiresAt: number } | null>} */
  async function get(key) {
    const { rows } = await store.query(
      `SELECT value, expires_at FROM ${store.tables.cache} WHERE cache_key = $1 AND expires_at > now()`,
      [k(key)]
    );
    if (!rows.length) return null;
    return { value: rows[0].value, expiresAt: new Date(rows[0].expires_at).getTime() };
  }

  /** @returns {Promise<Set<string>>} the keys (un-namespaced) that are present. */
  async function hasMany(keys) {
    if (!keys.length) return new Set();
    const { rows } = await store.query(
      `SELECT cache_key FROM ${store.tables.cache} WHERE cache_key = ANY($1::text[]) AND expires_at > now()`,
      [keys.map(k)]
    );
    const prefix = `${namespace}:`.length;
    return new Set(rows.map((r) => r.cache_key.slice(prefix)));
  }

  async function set(key, value, ttlSec) {
    await store.query(
      `INSERT INTO ${store.tables.cache} (cache_key, value, expires_at)
       VALUES ($1, $2::json, now() + make_interval(secs => $3))
       ON CONFLICT (cache_key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [k(key), JSON.stringify(value), ttlSec]
    );
  }

  return { get, hasMany, set };
}

module.exports = { createCacheStore };
