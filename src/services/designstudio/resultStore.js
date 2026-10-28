// =============================================================================
// resultStore.js — finished results a caller can still collect after its stream dropped.
// =============================================================================
//
// Measured 19 Oct 2026: Render's front door for the gateway dropped long streams
// (30-77 s) while the gateway and this service carried on and finished the job -
// a paid photograph nobody received. Every result is kept here under its jobId
// (sent in the first `start` event) and returned by GET /result/:jobId to the same
// account only.
//
// shortcut: kept in memory on one instance (WEB_CONCURRENCY=1 on Render) and lost on a
// restart; move to a shared store if the service ever runs on more than one instance.

const KEEP_MS = 15 * 60 * 1000; // after the job finishes
const MAX_RUNNING_MS = 60 * 60 * 1000; // a job that never finished is forgotten after this
const MAX_JOBS = 20; // a result holds one or two photographs of a few MB each

const jobs = new Map();

function prune(now = Date.now()) {
  for (const [id, j] of jobs) {
    if ((j.finishedAt && now - j.finishedAt > KEEP_MS) || now - j.startedAt > MAX_RUNNING_MS) jobs.delete(id);
  }
  // Oldest first (a Map keeps insertion order); a finished result goes before a running one.
  while (jobs.size > MAX_JOBS) {
    const oldestFinished = [...jobs].find(([, j]) => j.finishedAt);
    jobs.delete(oldestFinished ? oldestFinished[0] : jobs.keys().next().value);
  }
}

function begin(jobId, account) {
  jobs.set(jobId, { account: account || null, status: 'running', images: [], reading: null, done: null, error: null, startedAt: Date.now(), finishedAt: null });
  prune();
}

/** Keep what the caller was sent: its photographs and how the job ended. */
function record(jobId, event) {
  const j = jobs.get(jobId);
  if (!j || !event) return;
  if (event.type === 'image') {
    j.images = [...j.images.filter((i) => i.view !== event.view), event];
  } else if (event.type === 'reading') {
    j.reading = event; // POST /sketch: what was read from the drawing
  } else if (event.type === 'done') {
    j.done = event; j.status = 'done'; j.finishedAt = Date.now();
  } else if (event.type === 'error') {
    j.error = event; j.status = event.code === 'CANCELLED' ? 'cancelled' : 'error'; j.finishedAt = Date.now();
  }
}

/** The job, or null when unknown, expired or another account's. */
function get(jobId, account) {
  prune();
  const j = jobs.get(jobId);
  return j && j.account === (account || null) ? j : null;
}

module.exports = { begin, record, get, KEEP_MS, MAX_JOBS, _reset: () => jobs.clear() };
