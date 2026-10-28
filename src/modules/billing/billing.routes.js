// =============================================================================
// billing.routes.js — /internal/billing/*, for the Gateway only.
// =============================================================================
//
// GET /internal/billing/usage?clientId=&from=&to=
//   Delivered runs in [from, to), counted per kind and per garment, with the
//   run list. `clientId` is the Gateway's client id; leave it out for every
//   client at once (the console's month-end run). The Gateway prices them.
//
// Protected by the service key (mounted after requireServiceKey in index.js).
// The Gateway also attaches that key to every request it PROXIES for a third
// party, so a proxied request must never reach this route: the Gateway marks
// every proxied request with x-gateway-client-id, and this router refuses any
// request that carries it. Its own calls to this route never do.
//
const express = require('express');
const billing = require('./billing.service');

const router = express.Router();

const CLIENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000;

router.use((req, res, next) => {
  if (req.headers['x-gateway-client-id'] !== undefined) {
    return res.status(404).json({ success: false, error: 'Not found.' });
  }
  next();
});

function parseInstant(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

router.get('/usage', async (req, res, next) => {
  try {
    const { clientId } = req.query;
    if (clientId !== undefined && (typeof clientId !== 'string' || !CLIENT_ID.test(clientId))) {
      return res.status(400).json({ success: false, error: 'clientId is not valid.', code: 'INVALID_CLIENT_ID' });
    }
    const from = parseInstant(req.query.from);
    const to = parseInstant(req.query.to);
    if (!from || !to) {
      return res.status(400).json({ success: false, error: 'from and to are required, as ISO dates.', code: 'INVALID_RANGE' });
    }
    if (to <= from || to - from > MAX_RANGE_MS) {
      return res.status(400).json({ success: false, error: 'to must be after from, and the range at most 400 days.', code: 'INVALID_RANGE' });
    }

    const result = await billing.usage({ clientId: clientId || null, from, to });
    res.json({ success: true, clientId: clientId || null, from: from.toISOString(), to: to.toISOString(), ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
