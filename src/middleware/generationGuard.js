// =============================================================================
// generationGuard.js — the checks every generation passes before it starts.
// =============================================================================
//
// 1. Per-customer budget: GENERATION_RATE_LIMIT_PER_HOUR generations per hour
//    (0 turns it off), counted across all servers.
// 2. This server's capacity (see lib/capacity.js).
// 3. Replace this owner's previous job, wherever it is running, then list the
//    new one so a later cancel can find it from any server.
//
// Every refusal is a JSON 429 with Retry-After, sent before any stream opens.
// 4xx is deliberate: the gateway's circuit breaker counts 5xx per service, and a
// busy service must not be switched off by it.
//
const shared = require('../lib/shared');
const capacity = require('../lib/capacity');
const { ownerKey, budgetKey } = require('./identity');

const PER_HOUR = Number(process.env.GENERATION_RATE_LIMIT_PER_HOUR ?? 60);
const CAPACITY_RETRY_SEC = 10;

function refuse(res, retryAfterSec, error, extra = {}) {
  res.set('Retry-After', String(retryAfterSec));
  res.status(429).json({ success: false, error, retryAfterSec, ...extra });
  return null;
}

/**
 * @returns {Promise<null | { job: Object, release: () => Promise<void> }>}
 *          null when a response has already been sent.
 */
async function admitGeneration(req, res, { clientId, pipeline }) {
  // Budget first, so a customer who is out of budget never has their running job
  // stopped by a request that is about to be refused anyway.
  const bucket = `generation:${budgetKey(req, clientId)}`;
  if (PER_HOUR > 0) {
    const budget = await shared.rateLimiter.consume(bucket, 1, { limit: PER_HOUR, windowSec: 3600 });
    if (!budget.allowed) {
      console.warn(`[Limit] generation refused for ${budgetKey(req, clientId)}: ${budget.used}/${PER_HOUR} this hour`);
      return refuse(res, budget.retryAfterSec,
        `Generation limit reached: ${PER_HOUR} per hour. Retry in ${budget.retryAfterSec}s.`);
    }
  }

  // Replace the owner's previous job before taking a slot: the old job's slot is
  // freed as it unwinds, which is what lets a refresh-and-retry get in.
  const key = `${pipeline}:${ownerKey(req, clientId)}`;
  const replaced = await shared.jobs.cancel(key);
  if (replaced) console.log(`[Zombie Killer] ${key} started a new job; stopped the previous one.`);

  const releaseSlot = capacity.tryAcquire();
  if (!releaseSlot) {
    // Refused for this server's load, not the customer's use: give the unit back.
    if (PER_HOUR > 0) await shared.rateLimiter.refund(bucket, 1, { windowSec: 3600 });
    const { activeGenerations, maxConcurrent } = capacity.stats();
    console.warn(`[Capacity] Rejecting ${pipeline} generation for ${clientId}: ${activeGenerations}/${maxConcurrent} slots in use.`);
    return refuse(res, CAPACITY_RETRY_SEC, 'Service at capacity. Please retry shortly.', { activeGenerations, maxConcurrent });
  }

  const job = await shared.jobs.register(key, pipeline);
  let released = false;
  return {
    job,
    release: async () => {
      if (released) return;
      released = true;
      releaseSlot();
      await job.finish();
    }
  };
}

/** @returns {Promise<boolean>} whether a running job was found and stopped. */
function cancelGeneration(req, { clientId, pipeline }) {
  return shared.jobs.cancel(`${pipeline}:${ownerKey(req, clientId)}`);
}

module.exports = { admitGeneration, cancelGeneration, GENERATION_RATE_LIMIT_PER_HOUR: PER_HOUR };
