// =============================================================================
// identity.js — who is really calling.
// =============================================================================
//
// The `clientId` in a request body is whatever the caller typed. Limits keyed on
// it can be dodged by sending a new clientId each time, and one customer could
// cancel another customer's job by guessing theirs.
//
// The gateway authenticates the customer's API key and passes the customer's id
// in `x-gateway-client-id`. This middleware runs AFTER requireServiceKey, so only
// a caller holding the internal service key - the gateway - can set it.
//
//   req.account   the gateway's customer id, or null for a direct call
//
const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function identify(req, _res, next) {
  const raw = req.headers['x-gateway-client-id'];
  req.account = typeof raw === 'string' && ACCOUNT_ID.test(raw) ? raw : null;
  if (raw && !req.account) console.warn(`[identity] ignoring malformed x-gateway-client-id on ${req.originalUrl}`);
  next();
}

/**
 * The owner of a job or budget: the gateway customer when known, so customers
 * cannot touch each other's jobs, then the clientId they chose within it.
 */
function ownerKey(req, clientId) {
  return `${req.account || '-'}:${clientId}`;
}

/** The budget bucket: the whole customer when known, else the typed clientId. */
function budgetKey(req, clientId) {
  return req.account ? `account:${req.account}` : `client:${clientId}`;
}

module.exports = { identify, ownerKey, budgetKey };
