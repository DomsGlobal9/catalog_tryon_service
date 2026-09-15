// =============================================================================
// limiter.js — Cap how many provider calls run at the same moment.
// =============================================================================
//
// Why this exists, measured: 8 four-platform searches started together make 32
// simultaneous calls to the search provider, and 7 of the 32 came back at once
// with "quota or rate limit exhausted" - the provider limits concurrent use of a
// single key. The searches still answered, but with platforms missing.
//
// Calls beyond the cap wait in a queue instead of being fired and refused. A
// call that waits longer than `maxWaitMs` gives up with a ProviderError (424),
// so a burst can never hold a request open indefinitely.
//
// LIMITATION, by design: per process. Several instances each get their own cap.
//
const { ProviderError } = require('./errors');

/**
 * @param {number} max        Most calls allowed to run at once.
 * @param {Object} options
 * @param {number} options.maxWaitMs  Longest a call may queue before giving up.
 */
function createLimiter(max, { maxWaitMs }) {
  let active = 0;
  const queue = [];

  function release() {
    const next = queue.shift();
    if (next) {
      // Hand the slot straight to the next waiter; `active` is unchanged.
      clearTimeout(next.timer);
      next.resolve();
    } else {
      active--;
    }
  }

  async function run(fn) {
    if (active < max) {
      active++;
    } else {
      await new Promise((resolve, reject) => {
        const entry = { resolve, reject, timer: null };
        entry.timer = setTimeout(() => {
          const at = queue.indexOf(entry);
          if (at >= 0) queue.splice(at, 1);
          const waited = maxWaitMs >= 1000 ? `${Math.round(maxWaitMs / 1000)}s` : `${maxWaitMs}ms`;
          reject(new ProviderError(`Search capacity is busy: waited ${waited} for a free slot. Try again shortly.`));
        }, maxWaitMs);
        queue.push(entry);
      });
    }

    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { run, stats: () => ({ active, queued: queue.length, max }) };
}

module.exports = { createLimiter };
