// =============================================================================
// discoveryApi.js — Client for /api/v1/discovery/*
// =============================================================================
//
// Mirrors the environment handling in api.js: talk straight to the service in
// dev, go through the Super Admin gateway in production. Discovery rides the
// same `cat` slug as generation, so the same API key works.
//
const isDev = import.meta.env.DEV;

const BASE = isDev
  ? 'http://localhost:4005/api/v1/discovery'
  : (import.meta.env.VITE_DISCOVERY_URL ||
     'https://api-super-admin.onrender.com/api/gateway/cat/api/v1/discovery');

// No key is committed. In dev the frontend talks straight to the local
// service, which wants its own SERVICE_API_KEY (VITE_DEV_API_KEY here);
// in production it goes through the gateway, which wants the client key.
// Both live in frontend/.env, which is gitignored.
const API_KEY = import.meta.env.DEV
  ? import.meta.env.VITE_DEV_API_KEY
  : import.meta.env.VITE_API_KEY;

/**
 * Throws a shaped error so the UI can display the service's own contract -
 * 400 VALIDATION_ERROR with per-field details, 424 PROVIDER_UNAVAILABLE,
 * 429 RATE_LIMIT_EXCEEDED - rather than a generic failure.
 */
async function request(path, options = {}) {
  const started = Date.now();
  let response;

  try {
    response = await fetch(BASE + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, ...(options.headers || {}) }
    });
  } catch (networkError) {
    throw { status: 0, code: 'NETWORK_ERROR', message: `Cannot reach ${BASE}. Is the service running?` };
  }

  const elapsedMs = Date.now() - started;

  let body;
  try {
    body = await response.json();
  } catch {
    throw { status: response.status, code: 'BAD_RESPONSE', message: 'Response was not JSON.', elapsedMs };
  }

  if (!response.ok) {
    const err = body && body.error;
    throw {
      status: response.status,
      code: (err && err.code) || 'ERROR',
      message: (err && err.message) || (typeof err === 'string' ? err : 'Request failed.'),
      details: err && err.details,
      elapsedMs
    };
  }

  return { ...body, elapsedMs };
}

/** The full garment -> design area tree (12 garments / 107 areas). */
export const getTaxonomy = () => request('/taxonomy');

/** Supported garment ids, shot types and request limits. */
export const getCategories = () => request('/categories');

/**
 * @param {Object} payload  Any valid combination of keywords / category /
 *                          designType / instruction / filters / shotType /
 *                          page / limit.
 */
export const searchDesigns = (payload) =>
  request('/search', { method: 'POST', body: JSON.stringify(payload) });

export const DISCOVERY_BASE = BASE;
