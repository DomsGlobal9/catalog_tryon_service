// =============================================================================
// generationGuard.js — the checks every generation passes before it starts.
// =============================================================================
//
// 1. Per-customer budget, per product (19 Nov 2026): GENERATION_RATE_LIMIT_PER_HOUR catalog
//    generations per hour, GENERATION_RATE_LIMIT_PER_HOUR_STUDIO Design Studio ones (0 turns
//    one off), counted across all servers. Design Studio no longer eats the catalog's budget.
// 2. This server's capacity for that product (see lib/capacity.js).
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
const PER_HOUR_STUDIO = Number(process.env.GENERATION_RATE_LIMIT_PER_HOUR_STUDIO ?? PER_HOUR);
const CAPACITY_RETRY_SEC = 10;

// Which product's slots and budget a pipeline uses. Women's and men's catalog are one product.
const PRODUCT_OF = { women: 'catalog', men: 'catalog', designstudio: 'studio' };
const productOf = (pipeline) => PRODUCT_OF[pipeline] || 'catalog';
const limitOf = (product) => (product === 'studio' ? PER_HOUR_STUDIO : PER_HOUR);
// The catalog keeps its old bucket name, so counts already running are not reset.
const bucketOf = (product, req, clientId) => (product === 'catalog' ? `generation:${budgetKey(req, clientId)}` : `generation:${product}:${budgetKey(req, clientId)}`);

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
  const product = productOf(pipeline);
  const perHour = limitOf(product);
  const bucket = bucketOf(product, req, clientId);
  if (perHour > 0) {
    const budget = await shared.rateLimiter.consume(bucket, 1, { limit: perHour, windowSec: 3600 });
    if (!budget.allowed) {
      console.warn(`[Limit] ${product} generation refused for ${budgetKey(req, clientId)}: ${budget.used}/${perHour} this hour`);
      return refuse(res, budget.retryAfterSec,
        `Generation limit reached: ${perHour} per hour. Retry in ${budget.retryAfterSec}s.`);
    }
  }

  // Replace the owner's previous job before taking a slot: the old job's slot is
  // freed as it unwinds, which is what lets a refresh-and-retry get in.
  const key = `${pipeline}:${ownerKey(req, clientId)}`;
  const replaced = await shared.jobs.cancel(key);
  if (replaced) console.log(`[Zombie Killer] ${key} started a new job; stopped the previous one.`);

  const releaseSlot = capacity.tryAcquire(product);
  if (!releaseSlot) {
    // Refused for this server's load, not the customer's use: give the unit back.
    if (perHour > 0) await shared.rateLimiter.refund(bucket, 1, { windowSec: 3600 });
    const { activeGenerations, maxConcurrent } = capacity.stats(product);
    console.warn(`[Capacity] Rejecting ${pipeline} generation for ${clientId}: ${activeGenerations}/${maxConcurrent} ${product} slots in use.`);
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
