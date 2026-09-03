// =============================================================================
// redact.js — Keep provider credentials out of logs and error responses.
// =============================================================================

/**
 * Values registered here are scrubbed from any string passed through redact().
 * The Serper key is registered at boot by discovery.config.js.
 */
const secrets = new Set();

function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

/**
 * Replace every registered secret inside a string with a fixed marker.
 * Safe to call on anything — non-strings are returned untouched.
 */
function redact(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const secret of secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

module.exports = { registerSecret, redact };
