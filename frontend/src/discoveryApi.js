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

const HEADERS = () => ({ 'Content-Type': 'application/json', 'x-api-key': API_KEY });

const networkError = () =>
  ({ status: 0, code: 'NETWORK_ERROR', message: `Cannot reach ${BASE}. Is the service running?` });

/**
 * Turn a non-2xx response into a shaped error so the UI can display the
 * service's own contract - 400 VALIDATION_ERROR with per-field details,
 * 424 PROVIDER_UNAVAILABLE, 429 RATE_LIMIT_EXCEEDED - rather than a generic failure.
 */
async function toError(response, elapsedMs) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    return { status: response.status, code: 'BAD_RESPONSE', message: 'Response was not JSON.', elapsedMs };
  }
  const err = body && body.error;
  return {
    status: response.status,
    code: (err && err.code) || 'ERROR',
    message: (err && err.message) || (typeof err === 'string' ? err : 'Request failed.'),
    details: err && err.details,
    retryAfter: response.headers.get('retry-after'),
    elapsedMs
  };
}

async function request(path, options = {}) {
  const started = Date.now();
  let response;

  try {
    response = await fetch(BASE + path, { ...options, headers: { ...HEADERS(), ...(options.headers || {}) } });
  } catch {
    throw networkError();
  }

  const elapsedMs = Date.now() - started;
  if (!response.ok) throw await toError(response, elapsedMs);

  try {
    return { ...(await response.json()), elapsedMs };
  } catch {
    throw { status: response.status, code: 'BAD_RESPONSE', message: 'Response was not JSON.', elapsedMs };
  }
}

/** The full garment -> design area tree (12 garments / 107 areas). */
export const getTaxonomy = () => request('/taxonomy');

/** Supported garment ids, sources, shot types, result filters and limits. */
export const getCategories = () => request('/categories');

/** Waits for every source, then returns one JSON body. */
export const searchDesigns = (payload) =>
  request('/search', { method: 'POST', body: JSON.stringify(payload) });

/**
 * POST /search/stream - the same search, delivered as Server-Sent Events.
 *
 * The browser's EventSource cannot be used: it only does GET and cannot send the
 * x-api-key header. So the response body is read directly and split into events.
 *
 * `onEvent` is called with each event object as it arrives:
 *   { type: 'start' }  ->  { type: 'source' } per source  ->  { type: 'done' }
 *
 * Resolves `{ aborted: false }` when the stream ends, `{ aborted: true }` if the
 * signal was aborted. Throws a shaped error if the service refused the request up
 * front - it answers those as normal JSON (400/401/424/429) before any stream opens.
 */
export async function streamDesigns(payload, onEvent, signal) {
  let response;
  try {
    response = await fetch(BASE + '/search/stream', {
      method: 'POST',
      headers: HEADERS(),
      body: JSON.stringify(payload),
      signal
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return { aborted: true };
    throw networkError();
  }

  if (!response.ok) throw await toError(response, 0);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        // Lines starting ':' are keep-alive comments; only `data:` lines carry an event.
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue; // a malformed frame must not end an otherwise good stream
        }
        onEvent(event);
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return { aborted: true };
    throw { status: 0, code: 'STREAM_INTERRUPTED', message: 'The connection dropped before the search finished.' };
  }

  return { aborted: false };
}

export const DISCOVERY_BASE = BASE;
