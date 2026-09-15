// =============================================================================
// errors.js — Design Studio's typed errors and its error handler.
// =============================================================================
//
// STATUS POLICY: this service shares the gateway slug with try-on and discovery,
// and the gateway's circuit breaker switches the whole slug off after repeated
// 5xx. Every anticipated failure is therefore a 4xx - including the image model
// being unavailable (424). Only a genuine bug is a 500.
//
// Nothing here ever echoes an API key or a full base64 payload.
//
const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /([?&](key|api_key|signature)=)[^&\s"]+/gi,
  /data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]{40,}/gi,
  /[A-Za-z0-9+/]{400,}={0,2}/g // long base64 runs
];

function redact(text) {
  let out = String(text == null ? '' : text);
  for (const pattern of SECRET_PATTERNS) {
    // Only the query-string pattern has a capture group; keep its "key=" prefix.
    out = out.replace(pattern, (m, p1) => (typeof p1 === 'string' && m.startsWith(p1) ? `${p1}[redacted]` : '[redacted]'));
  }
  return out.length > 600 ? out.slice(0, 600) + '…' : out;
}

class StudioError extends Error {
  /**
   * @param {string} message   Safe to show the caller.
   * @param {Object} o
   * @param {number} o.status  HTTP status when raised before the stream opens.
   * @param {string} o.code    Stable machine-readable code.
   * @param {boolean} [o.retryable]
   * @param {*} [o.details]
   */
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', retryable = false, details } = {}) {
    super(redact(message));
    this.name = 'StudioError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }

  toJSON() {
    const error = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.details !== undefined) error.details = this.details;
    return error;
  }
}

const validation = (message, details) => new StudioError(message, { status: 400, code: 'VALIDATION_ERROR', details });

function studioErrorHandler(err, req, res, _next) {
  if (res.headersSent) {
    // A stream is already open; the controller reports failures inside it.
    if (!res.writableEnded) res.end();
    return;
  }
  if (err instanceof StudioError) {
    if (err.retryAfterSec) res.set('Retry-After', String(err.retryAfterSec));
    return res.status(err.status).json({ success: false, error: err.toJSON() });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large. Send fewer or smaller images.', retryable: false }
    });
  }
  if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err))) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.', retryable: false } });
  }
  console.error('[DesignStudio] unexpected error:', redact(err && err.stack ? err.stack : err));
  return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error', retryable: true } });
}

module.exports = { StudioError, validation, redact, studioErrorHandler };
