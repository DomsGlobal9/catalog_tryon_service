/**
 * Internal API Key Authentication Middleware
 * 
 * Ensures that requests coming to this microservice are actually from our 
 * authorized Super Admin Gateway and not direct, malicious external requests.
 */

function requireServiceKey(req, res, next) {
  // Allow health checks to pass without an API key for load balancers
  if (req.path === '/health') return next();

  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.SERVICE_API_KEY;

  if (!expectedKey) {
    console.error('CRITICAL: SERVICE_API_KEY is not configured in .env');
    return res.status(500).json({ success: false, error: 'Server misconfiguration' });
  }

  if (!apiKey || apiKey !== expectedKey) {
    console.warn(`[SECURITY] Blocked unauthorized request to ${req.originalUrl} from IP: ${req.ip}`);
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing Service API Key' });
  }

  next();
}

module.exports = {
  requireServiceKey
};
