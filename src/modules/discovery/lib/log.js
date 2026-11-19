// =============================================================================
// log.js — Discovery's log lines: one per search, one per provider call that did not simply work.
// =============================================================================
//
// Local to the discovery module (it imports nothing from the rest of src/, so it can be lifted out
// on its own), in the same shape as the service's other lines (src/lib/stepLog.js):
//
//   [Discovery] searchId=… endpoint=search client=… garment=SAREE item=PALLU result=found results=12 …
//   [AI] searchId=… endpoint=search call=search provider=serper attempt=1 of=3 result=retrying reason="… HTTP 503." waitSeconds=0.6
//
// Only short values are logged, never a key; values are cut and stripped of line breaks.

const { AsyncLocalStorage } = require('node:async_hooks');

const MAX_VALUE = 160;
const context = new AsyncLocalStorage();

function format(value) {
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_VALUE);
  return /\s|"/.test(text) ? JSON.stringify(text) : text;
}

function line(area, fields) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${format(v)}`);
  console.log(`[${area}] ${parts.join(' ')}`);
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
function providerLog(fields) {
  const c = context.getStore() || {};
  line('AI', { searchId: c.searchId, endpoint: c.endpoint, ...fields });
}

const secondsSince = (startedAt) => Math.round((Date.now() - startedAt) / 100) / 10;

module.exports = { line, providerLog, contextMiddleware, setContext, secondsSince };
