// =============================================================================
// billing.service.js — what a third party is charged for, recorded once.
// =============================================================================
//
// THE RULE: only what was delivered is charged, and only once.
//
// This service is the only place that knows a run delivered all of its views,
// and whether it was a normal catalog or a colour variant. So it writes one row
// per FULLY delivered run into se_catalog.billable_runs. The Gateway (Platform
// Console) owns everything about money - prices, GST, limits and bills - and
// reads these rows through GET /internal/billing/usage.
//
//   - A failed, cancelled, timed-out or partial run writes nothing.
//   - The same request retried is one row: rows are unique per
//     (client, requestKey), and a jobId that was already delivered is refused
//     before any AI work starts (see findDelivered).
//   - Only runs that came through the Gateway are recorded. A direct call with
//     the service key has no Gateway client, so it is ScaleEzy's own use.
//   - A billing write that fails is logged loudly and never breaks the stream:
//     the customer still gets the catalog they waited for.
//
const crypto = require('crypto');
const { prisma, pool } = require('../../lib/db');

const KIND = Object.freeze({
  CATALOG: 'CATALOG',               // four views, in the garment's own colour
  COLOUR_VARIANT: 'COLOUR_VARIANT'  // four views, in a requested colour
});

/** A full women's catalog is four views; anything less is not charged. */
const FULL_CATALOG_VIEWS = 4;

const CALLER_JOB_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const GATEWAY_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

class BillingInputError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.statusCode = 400;
  }
}

/**
 * The caller's own id for this run, if they sent one. Optional; a number is
 * accepted as text, like clientId.
 * @throws {BillingInputError} when one is sent but cannot be used.
 */
function callerJobId(body) {
  const raw = body && body.jobId;
  if (raw === undefined || raw === null || raw === '') return null;
  const value = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
  if (typeof value !== 'string' || !CALLER_JOB_ID.test(value.trim())) {
    throw new BillingInputError(
      'jobId must be up to 128 letters, digits, dots, dashes, underscores or colons.',
      'INVALID_JOB_ID'
    );
  }
  return value.trim();
}

/** The Gateway's id for this request (sent as X-Request-ID), when it is well formed. */
function gatewayRequestId(req) {
  const raw = req.headers['x-request-id'];
  return typeof raw === 'string' && GATEWAY_REQUEST_ID.test(raw) ? raw : null;
}

/**
 * What makes a run "the same request": the caller's jobId when they send one,
 * else the Gateway's request id. Null when the run is not billable at all
 * (a direct call, not through the Gateway).
 */
function requestKeyFor(req, jobId) {
  if (!req.account) return null;
  if (jobId) return `job:${jobId}`;
  const gw = gatewayRequestId(req);
  return gw ? `req:${gw}` : null;
}

/**
 * A short fingerprint of the uploaded garment, so colour runs can be listed
 * under the garment they came from. The photo itself is never stored. A link
 * is fingerprinted as the link; base64 as its bytes (data: prefix dropped, so
 * the same photo sent both ways as base64 matches).
 */
function garmentRef(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  let text = input.trim();
  if (text.startsWith('data:')) text = text.slice(text.indexOf(',') + 1);
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * Has this exact request already been delivered (and so charged)? Used before
 * generation starts so a reused jobId cannot buy a second catalog for free.
 * Fails open: if the database cannot answer, the run is allowed, and the
 * unique key still guarantees it is charged at most once.
 */
async function findDelivered(clientId, requestKey) {
  if (!clientId || !requestKey) return null;
  try {
    return await prisma.billableRun.findUnique({
      where: { clientId_requestKey: { clientId, requestKey } },
      select: { id: true, kind: true, deliveredAt: true }
    });
  } catch (err) {
    console.error(`[Billing] could not check request ${requestKey} for ${clientId}:`, err.message);
    return null;
  }
}

/**
 * Record one fully delivered run. Returns true when a new row was written,
 * false when nothing was charged (not billable, partial, or already recorded).
 * Never throws.
 */
async function recordDeliveredRun({ clientId, requestKey, colour, garment, views, drapeJobId, gatewayRequestId: gwId }) {
  if (!clientId || !requestKey) return false;
  if (views < FULL_CATALOG_VIEWS) {
    console.log(`[Billing] ${requestKey} for ${clientId} delivered ${views}/${FULL_CATALOG_VIEWS} views: not charged.`);
    return false;
  }
  const kind = colour ? KIND.COLOUR_VARIANT : KIND.CATALOG;
  const row = {
    clientId,
    kind,
    requestKey,
    colourName: colour ? colour.name || null : null,
    colourHex: colour ? colour.hex || null : null,
    garmentRef: garmentRef(garment),
    views,
    drapeJobId: drapeJobId || null,
    gatewayRequestId: gwId || null,
    deliveredAt: new Date()
  };
  try {
    const { count } = await prisma.billableRun.createMany({ data: [row], skipDuplicates: true });
    if (count === 0) console.log(`[Billing] ${requestKey} for ${clientId} was already recorded: not charged again.`);
    else console.log(`[Billing] recorded ${kind} for ${clientId} (${requestKey}).`);
    return count === 1;
  } catch (err) {
    // Loud on purpose: this is a delivered run that is not on a bill yet. The
    // row is kept on its draping job so the next usage read records it (see
    // recoverUnrecorded) - a delivered run must never be lost to a write failure.
    console.error(`[Billing] COULD NOT RECORD delivered ${kind} for ${clientId} (${requestKey}), kept on job ${drapeJobId} to record later:`, err.message);
    if (drapeJobId) {
      try {
        await pool.query(`UPDATE se_catalog.draping_jobs SET error_message = $2 WHERE id = $1`,
          [drapeJobId, `${UNRECORDED} ${JSON.stringify(row)}`]);
      } catch (e) {
        console.error(`[Billing] could not keep the unrecorded run on job ${drapeJobId} either:`, e.message);
      }
    }
    return false;
  }
}

const UNRECORDED = 'BILLING_NOT_RECORDED';
const RECORDED_LATE = 'BILLING_RECORDED_LATE';

/**
 * Record runs whose billing write failed at delivery (kept on their draping job
 * as BILLING_NOT_RECORDED {row}). Called before usage is read, so a miss is
 * billed at the next read, at the moment it was delivered, exactly once (the
 * unique key holds). Never throws: a failure here leaves them for next time.
 */
async function recoverUnrecorded() {
  let pending;
  try {
    pending = await pool.query(
      `SELECT id, error_message FROM se_catalog.draping_jobs WHERE status = 'COMPLETED' AND error_message LIKE $1 LIMIT 500`,
      [`${UNRECORDED} %`]);
  } catch (err) {
    console.error('[Billing] could not look for unrecorded runs:', err.message);
    return 0;
  }
  let recovered = 0;
  for (const job of pending.rows) {
    try {
      const row = JSON.parse(job.error_message.slice(UNRECORDED.length + 1));
      await prisma.billableRun.createMany({ data: [{ ...row, deliveredAt: new Date(row.deliveredAt) }], skipDuplicates: true });
      await pool.query(`UPDATE se_catalog.draping_jobs SET error_message = $2 WHERE id = $1`,
        [job.id, `${RECORDED_LATE} ${job.error_message.slice(UNRECORDED.length + 1)}`]);
      recovered += 1;
    } catch (err) {
      console.error(`[Billing] could not record the kept run on job ${job.id} yet:`, err.message);
    }
  }
  if (recovered) console.log(`[Billing] recorded ${recovered} delivered run(s) that had been kept for later.`);
  return recovered;
}

/**
 * Delivered runs in [from, to), for one client or for all of them.
 * @returns {Promise<{ totals: Object, garments: Object[], runs: Object[] }>}
 */
async function usage({ clientId, from, to }) {
  await recoverUnrecorded();
  const where = { deliveredAt: { gte: from, lt: to } };
  if (clientId) where.clientId = clientId;
  const rows = await prisma.billableRun.findMany({
    where,
    orderBy: [{ deliveredAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, clientId: true, kind: true, requestKey: true, colourName: true, colourHex: true,
      garmentRef: true, views: true, gatewayRequestId: true, deliveredAt: true
    }
  });

  const totals = { [KIND.CATALOG]: 0, [KIND.COLOUR_VARIANT]: 0 };
  const byGarment = new Map();
  for (const r of rows) {
    totals[r.kind] = (totals[r.kind] || 0) + 1;
    const key = `${r.clientId}|${r.garmentRef || '-'}`;
    if (!byGarment.has(key)) {
      byGarment.set(key, { clientId: r.clientId, garmentRef: r.garmentRef, catalogs: 0, colourVariants: 0, colours: [] });
    }
    const g = byGarment.get(key);
    if (r.kind === KIND.COLOUR_VARIANT) {
      g.colourVariants += 1;
      if (r.colourName && !g.colours.includes(r.colourName)) g.colours.push(r.colourName);
    } else {
      g.catalogs += 1;
    }
  }

  return {
    totals,
    garments: [...byGarment.values()],
    runs: rows.map((r) => ({ ...r, deliveredAt: r.deliveredAt.toISOString() }))
  };
}

module.exports = {
  KIND,
  FULL_CATALOG_VIEWS,
  BillingInputError,
  callerJobId,
  gatewayRequestId,
  requestKeyFor,
  garmentRef,
  findDelivered,
  recordDeliveredRun,
  recoverUnrecorded,
  usage
};
