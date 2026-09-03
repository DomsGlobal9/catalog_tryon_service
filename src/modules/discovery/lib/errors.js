// =============================================================================
// errors.js — Typed errors for the discovery module.
// =============================================================================
//
// STATUS CODE POLICY (important — read before changing):
//
// This module shares a gateway slug ('cat') with the draping/generation routes,
// and the Super Admin gateway runs a PER-SLUG circuit breaker: five responses of
// >= 500 within 60 seconds trip the whole slug OPEN for five minutes. That would
// take generate-catalog offline as collateral damage.
//
// So every *anticipated* failure here is a 4xx, including upstream provider
// outages (424 Failed Dependency) and missing provider configuration. Only a
// genuine, unexpected internal defect is allowed to surface as a 500 — mapping
// real bugs to 4xx would hide them and misreport what happened.
//
const { redact } = require('./redact');

class AppError extends Error {
  constructor(message, { statusCode, code, details } = {}) {
    super(redact(message));
    this.name = this.constructor.name;
    this.statusCode = statusCode || 500;
    this.code = code || 'INTERNAL_ERROR';
    this.details = details;
    this.expected = true;
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  }

  toResponse() {
    const body = { success: false, error: { code: this.code, message: this.message } };
    if (this.details !== undefined) body.error.details = this.details;
    return body;
  }
}

/** Caller sent something we cannot act on. */
class ValidationError extends AppError {
  constructor(message, details) {
    super(message, { statusCode: 400, code: 'VALIDATION_ERROR', details });
  }
}

/** Caller exceeded this service's per-client search budget. */
class RateLimitError extends AppError {
  constructor(message, retryAfterSec) {
    super(message, { statusCode: 429, code: 'RATE_LIMIT_EXCEEDED' });
    this.retryAfterSec = retryAfterSec;
  }
}

/** The upstream search provider failed, timed out, or rejected us. */
class ProviderError extends AppError {
  constructor(message, details) {
    super(message, { statusCode: 424, code: 'PROVIDER_UNAVAILABLE', details });
  }
}

/** Discovery is deployed but has no provider credentials — it is simply off. */
class NotConfiguredError extends AppError {
  constructor(message) {
    super(
      message || 'Design discovery is not configured on this deployment (missing SERPER_API_KEY).',
      { statusCode: 424, code: 'DISCOVERY_NOT_CONFIGURED' }
    );
  }
}

/**
 * Express error handler, mounted at the end of the discovery router so it only
 * ever sees this module's failures and never interferes with draping routes.
 */
function discoveryErrorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    if (err.retryAfterSec) res.setHeader('Retry-After', String(err.retryAfterSec));
    return res.status(err.statusCode).json(err.toResponse());
  }

  // express.json() failures — both are caller faults, so both stay 4xx.
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the discovery limit.' }
    });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' }
    });
  }

  // Genuinely unexpected: report it honestly rather than disguising it as 4xx.
  console.error('[Discovery] Unhandled error:', redact(err && err.stack ? err.stack : String(err)));
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' }
  });
}

module.exports = {
  AppError,
  ValidationError,
  RateLimitError,
  ProviderError,
  NotConfiguredError,
  discoveryErrorHandler
};
