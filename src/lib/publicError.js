// =============================================================================
// publicError.js — what a caller may be told about a failure.
// =============================================================================
//
// Raw upstream text (Gemini's error bodies, Prisma's "can't reach database at
// host:port") is for our logs. A caller sees an error's own message only when
// the error says it is written for them (`expose`, set by body-parser's 4xx
// errors, ImageFetchError and InvalidColour); otherwise one plain sentence.
//
function publicMessage(err, fallback = 'Generation failed. Please try again.') {
  return err && err.expose && err.message ? err.message : fallback;
}

/** The HTTP status for a refused request: the error's own 4xx, else 500. */
function publicStatus(err) {
  const status = Number(err && (err.status || err.statusCode));
  return status >= 400 && status < 500 ? status : 500;
}

module.exports = { publicMessage, publicStatus };
