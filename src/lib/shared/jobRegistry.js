// =============================================================================
// jobRegistry.js — running generation jobs, visible to every server.
// =============================================================================
//
// A generation runs on whichever server the load balancer picked. A later
// "cancel", or a new generation from the same customer that should replace the
// old one, may land on a different server. So:
//
//   * every running job is listed in the shared `active_jobs` table;
//   * cancelling marks the row, on whatever server receives the cancel;
//   * the server running the job checks its rows every `pollMs` and stops the
//     job when it sees the mark. The same query doubles as a heartbeat, which is
//     how a job belonging to a crashed server is recognised as dead.
//
// Jobs on the SAME server are still cancelled instantly, without the database.
// If the database is unavailable, cancelling works for jobs on the same server
// only - exactly the behaviour before this existed.
//
const crypto = require('crypto');
const { SharedStoreUnavailable } = require('./store');

/** A job is live if its server sent a heartbeat within this long. */
const LIVE_WITHIN_SEC = 30;

function createJobRegistry({ store, instanceId, pollMs = 1500, log = console }) {
  /** @type {Map<string, { key: string, pipeline: string, controller: AbortController }>} */
  const local = new Map();
  let poller = null;

  const ignoreUnavailable = (err) => {
    if (!(err instanceof SharedStoreUnavailable)) log.warn('[jobs] shared job registry error:', err.message);
  };

  async function poll() {
    if (!local.size) return;
    const ids = [...local.keys()];
    try {
      const { rows } = await store.query(
        `UPDATE ${store.tables.jobs} SET heartbeat_at = now()
          WHERE job_id = ANY($1::text[])
          RETURNING job_id, cancel_requested`,
        [ids]
      );
      for (const row of rows) {
        if (row.cancel_requested) abortLocal(row.job_id, 'cancelled from another server');
      }
    } catch (err) {
      ignoreUnavailable(err);
    }
  }

  function ensurePolling() {
    if (poller || !local.size) return;
    poller = setInterval(() => {
      poll().catch(ignoreUnavailable);
      if (!local.size) {
        clearInterval(poller);
        poller = null;
      }
    }, pollMs);
    if (poller.unref) poller.unref();
  }

  function abortLocal(jobId, reason) {
    const job = local.get(jobId);
    if (!job) return false;
    log.log(`[jobs] stopping ${job.pipeline} job ${jobId} for ${job.key}: ${reason}`);
    job.controller.abort();
    local.delete(jobId);
    return true;
  }

  /**
   * Stop every running job under `key`, on any server.
   * @returns {Promise<boolean>} whether a running job was found.
   */
  async function cancel(key) {
    let found = false;
    for (const [jobId, job] of local) {
      if (job.key === key) found = abortLocal(jobId, 'cancel requested') || found;
    }
    try {
      const { rowCount } = await store.query(
        `UPDATE ${store.tables.jobs} SET cancel_requested = true
          WHERE job_key = $1 AND cancel_requested = false
            AND heartbeat_at > now() - make_interval(secs => $2)`,
        [key, LIVE_WITHIN_SEC]
      );
      // Rows for jobs this server just stopped are counted too, which is harmless:
      // they were running, and they are deleted as their handlers unwind.
      found = found || rowCount > 0;
    } catch (err) {
      ignoreUnavailable(err);
    }
    return found;
  }

  /**
   * List a job that is about to start. Call `cancel(key)` first if a new job
   * should replace an old one.
   *
   * @returns {Promise<{ id: string, signal: AbortSignal, abort: () => void, finish: () => Promise<void> }>}
   */
  async function register(key, pipeline) {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    local.set(id, { key, pipeline, controller });

    try {
      await store.query(
        `INSERT INTO ${store.tables.jobs} (job_id, job_key, pipeline, instance_id) VALUES ($1, $2, $3, $4)`,
        [id, key, pipeline, instanceId]
      );
    } catch (err) {
      ignoreUnavailable(err);
    }
    ensurePolling();

    let finished = false;
    return {
      id,
      signal: controller.signal,
      abort: () => abortLocal(id, 'caller disconnected'),
      finish: async () => {
        if (finished) return;
        finished = true;
        local.delete(id);
        try {
          await store.query(`DELETE FROM ${store.tables.jobs} WHERE job_id = $1`, [id]);
        } catch (err) {
          ignoreUnavailable(err);
        }
      }
    };
  }

  /** Forget this server's rows on shutdown so no one waits on them. */
  async function shutdown() {
    if (poller) clearInterval(poller);
    poller = null;
    const ids = [...local.keys()];
    if (!ids.length) return;
    try {
      await store.query(`DELETE FROM ${store.tables.jobs} WHERE job_id = ANY($1::text[])`, [ids]);
    } catch (err) {
      ignoreUnavailable(err);
    }
  }

  function stats() {
    return { runningHere: local.size };
  }

  return { cancel, register, shutdown, stats, _poll: poll };
}

module.exports = { createJobRegistry, LIVE_WITHIN_SEC };
