// =============================================================================
// designStudioApi.js — Client for /api/v1/designstudio/*
// =============================================================================
//
// Same environment handling as discoveryApi.js: talk straight to the local
// service in dev, go through the Super Admin gateway in production. Design
// Studio rides the same `cat` slug, so the same API key works.
//
// Three calls:
//   getOptions()                      GET  /options   garments, areas, limits
//   generateGarment(payload, onEvent) POST /generate  a live event stream
//   cancelGarment(clientId)           POST /cancel    stop what is running
//
const isDev = import.meta.env.DEV;

// VITE_DEV_DESIGNSTUDIO_URL points the harness at a different service - a second
// local instance, or a staging one - without touching this file.
const BASE = isDev
  ? (import.meta.env.VITE_DEV_DESIGNSTUDIO_URL || 'http://localhost:4005/api/v1/designstudio')
  : (import.meta.env.VITE_DESIGNSTUDIO_URL ||
     'https://api-super-admin.onrender.com/api/gateway/cat/api/v1/designstudio');

// No key is committed. In dev the frontend talks straight to the local
// service, which wants its own SERVICE_API_KEY (VITE_DEV_API_KEY here);
// in production it goes through the gateway, which wants the client key.
// Both live in frontend/.env, which is gitignored.
const API_KEY = isDev
  ? import.meta.env.VITE_DEV_API_KEY
  : import.meta.env.VITE_API_KEY;

const HEADERS = () => ({ 'Content-Type': 'application/json', 'x-api-key': API_KEY });

const networkError = () => ({
  status: 0,
  code: 'NETWORK_ERROR',
  message: `Cannot reach ${BASE}. Is the service running?`
});

/**
 * Turn a non-2xx response into the shape the UI renders, keeping the service's
 * own contract visible: 400 VALIDATION_ERROR with per-field `details`,
 * 422 IMAGE_UNUSABLE listing every bad image, 413, 429 with Retry-After.
 *
 * Also survives two things seen in production: a gateway that answers HTML
 * instead of JSON, and a freshly started instance that once answered with an
 * empty body.
 */
async function toError(response, elapsedMs) {
  const retryAfter = response.headers.get('retry-after');
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }

  if (!body.trim()) {
    return {
      status: response.status,
      code: 'EMPTY_RESPONSE',
      message: 'The service answered with no body. Retry once - a just-started instance can do this.',
      retryAfter,
      elapsedMs
    };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      status: response.status,
      code: 'BAD_RESPONSE',
      message: `Response was not JSON: ${body.slice(0, 200)}`,
      retryAfter,
      elapsedMs
    };
  }

  const err = parsed && parsed.error;
  return {
    status: response.status,
    code: (err && err.code) || 'ERROR',
    message: (err && err.message) || (typeof err === 'string' ? err : 'Request failed.'),
    details: err && err.details,
    retryable: err && err.retryable,
    retryAfter,
    elapsedMs
  };
}

/** Everything needed to build a valid request: 12 garments, their areas, the limits. */
export async function getOptions() {
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${BASE}/options`, { headers: HEADERS() });
  } catch {
    throw networkError();
  }
  if (!response.ok) throw await toError(response, Date.now() - started);
  try {
    return await response.json();
  } catch {
    throw { status: response.status, code: 'BAD_RESPONSE', message: 'Options was not JSON.' };
  }
}

/**
 * POST /generate — one garment, worn by a model, as a Server-Sent Event stream.
 *
 * The browser's EventSource cannot be used: it only does GET and cannot send
 * the x-api-key header. So the body is read directly and split on blank lines.
 *
 * `onEvent` is called with each event as it arrives:
 *   start -> status(reading-references) -> brief -> status(generating) -> image -> done
 * or a single `error` event in place of image+done.
 *
 * Resolves `{ aborted, image, done, error }`. Throws a shaped error only when
 * the request was refused BEFORE the stream opened (400/401/413/422/429) - the
 * service answers those as ordinary JSON, so status is checked first.
 */
export async function generateGarment(payload, onEvent, signal) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${BASE}/generate`, {
      method: 'POST',
      headers: HEADERS(),
      body: JSON.stringify(payload),
      signal
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return { aborted: true };
    throw networkError();
  }

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !contentType.includes('text/event-stream')) {
    throw await toError(response, Date.now() - started);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const result = { aborted: false, image: null, done: null, error: null, keepalives: 0 };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        // Lines starting ':' are keep-alive comments. They matter here: they
        // prove the gateway is not buffering a 30-second stream.
        if (frame.startsWith(':')) {
          result.keepalives++;
          continue;
        }

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
          continue; // one malformed frame must not end an otherwise good stream
        }

        if (event.type === 'image') result.image = event;
        if (event.type === 'done') result.done = event;
        if (event.type === 'error') result.error = event;
        if (onEvent) onEvent(event);
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return { ...result, aborted: true };
    throw {
      status: 0,
      code: 'STREAM_INTERRUPTED',
      message: 'The connection dropped before the garment finished.'
    };
  }

  return result;
}

/**
 * POST /cancel — stop whatever is running for this clientId.
 *
 * `keepalive` so it still goes out from a beforeunload handler when the tab is
 * closing mid-generation; otherwise the job would keep a capacity slot until it
 * noticed the dropped connection.
 */
export async function cancelGarment(clientId) {
  try {
    const response = await fetch(`${BASE}/cancel`, {
      method: 'POST',
      headers: HEADERS(),
      body: JSON.stringify({ clientId }),
      keepalive: true
    });
    return await response.json();
  } catch {
    return { success: false, cancelled: false, message: 'Could not reach the service to cancel.' };
  }
}

export const DESIGNSTUDIO_BASE = BASE;
