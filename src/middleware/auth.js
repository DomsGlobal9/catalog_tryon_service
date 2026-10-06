/**
 * Internal API Key Authentication Middleware
 * 
 * Ensures that requests coming to this microservice are actually from our 
 * authorized Super Admin Gateway and not direct, malicious external requests.
 */

const crypto = require('crypto');

/** Constant-time compare, so response timing cannot reveal the key a byte at a time. */
function keysMatch(given, expected) {
  if (typeof given !== 'string' || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireServiceKey(req, res, next) {
  // Allow health checks to pass without an API key for load balancers
  if (req.path === '/health') return next();

  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.SERVICE_API_KEY;

  if (!expectedKey) {
    console.error('CRITICAL: SERVICE_API_KEY is not configured in .env');
    return res.status(500).json({ success: false, error: 'Server misconfiguration' });
  }

  if (!keysMatch(apiKey, expectedKey)) {
    console.warn(`[SECURITY] Blocked unauthorized request to ${req.originalUrl} from IP: ${req.ip}`);
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing Service API Key' });
  }

  next();
}

module.exports = {
  requireServiceKey
};
