// =============================================================================
// log.js — Discovery's log lines: one per search, one per provider call that did not simply work.
// =============================================================================
//
// Local to the discovery module (it imports nothing from the rest of src/, so it can be lifted out
// on its own), readable like the service's other lines (src/lib/stepLog.js):
//
//   [Discovery] search SAREE/PALLU · found 12 in 1.4s · sources web:12 · read from text · client shop-7 · search 3f9a12bc
//   [AI] search · search try 1/3 failed, retrying in 0.6s · serper returned HTTP 503 · serper · search 3f9a12bc
//
// Only short values are logged, never a key; values are cut and stripped of line breaks.

const { AsyncLocalStorage } = require('node:async_hooks');

const MAX_VALUE = 160;
const SEP = ' · ';
const context = new AsyncLocalStorage();

const has = (v) => v !== undefined && v !== null && v !== '';
const clean = (v) => String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE);
const short = (id) => (has(id) ? clean(id).slice(0, 8) : null);

/** One search, as one line. */
function searchLine(f) {
  const what = f.result === 'found'
    ? `found ${has(f.results) ? f.results : 0}${has(f.seconds) ? ` in ${f.seconds}s` : ''}`
    : `FAILED${has(f.seconds) ? ` after ${f.seconds}s` : ''}`;
  const words = [
    what,
    has(f.sources) ? `sources ${clean(f.sources)}` : null,
    has(f.from) ? `read from ${clean(f.from)}` : null,
    has(f.status) ? `stream ${clean(f.status)}` : null,
    has(f.left) ? clean(f.left) : null,
    has(f.client) ? `client ${clean(f.client)}` : null,
    has(f.searchId) ? `search ${short(f.searchId)}` : null
  ].filter(Boolean);
  const head = [f.endpoint || 'search', [f.garment, f.item].filter(has).map(clean).join('/')].filter(Boolean).join(' ');
  console.log(`[Discovery] ${[head, ...words].join(SEP)}`);
}

/** Express middleware: every Discovery request gets its own context. */
function contextMiddleware(_req, _res, next) {
  context.run({}, next);
}

/** Add to the current request's context (searchId, endpoint). */
function setContext(fields) {
  const store = context.getStore();
  if (store) Object.assign(store, fields);
}

/** A provider call that failed, is being retried, gave up, or worked after a retry. */
function providerLog(f) {
  const c = context.getStore() || {};
  const call = clean(f.call || 'search');
  const n = has(f.attempt) ? `${f.attempt}${has(f.of) ? `/${f.of}` : ''}` : null;
  const what = {
    retrying: `${call}${n ? ` try ${n}` : ''} failed, retrying${has(f.waitSeconds) ? ` in ${f.waitSeconds}s` : ''}`,
    gave_up: `${call}${n ? ` try ${n}` : ''} failed - GIVING UP`,
    failed: `${call} FAILED (not retried)`,
    ok_after_retry: `${call} OK on try ${has(f.attempt) ? f.attempt : '?'}`
  }[f.result] || `${call} ${clean(f.result || '')}`;
  const words = [what, has(f.reason) ? clean(f.reason) : null, has(f.provider) ? clean(f.provider) : null,
    has(c.searchId) ? `search ${short(c.searchId)}` : null].filter(Boolean);
  console.log(`[AI] ${[c.endpoint || 'search', ...words].join(SEP)}`);
}

const secondsSince = (startedAt) => Math.round((Date.now() - startedAt) / 100) / 10;

module.exports = { searchLine, providerLog, contextMiddleware, setContext, secondsSince };
