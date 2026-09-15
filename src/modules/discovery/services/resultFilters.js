// =============================================================================
// resultFilters.js — Filters applied to results AFTER the search comes back.
// =============================================================================
//
// These are different in kind from `filters.color / fabric / occasion`. Those are
// words added to the search and are not verified against the images. These are
// checked against data every result actually carries, so they are GUARANTEED:
// a result that survives `fullSizeOnly` really is a full-size image.
//
// They run after the cache, so the same search with different filters costs no
// extra provider call.
//
// A filter that needs a size is strict about unknowns: a result whose size the
// source did not report cannot be shown to meet `minWidth` or an orientation, so
// it is removed rather than let through on a guess.
//

/** Ratio band treated as square: width/height between these. */
const SQUARE_MIN = 0.95;
const SQUARE_MAX = 1.05;

function orientationOf(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const ratio = width / height;
  if (ratio < SQUARE_MIN) return 'portrait';
  if (ratio > SQUARE_MAX) return 'landscape';
  return 'square';
}

/** "https://www.Amazon.in/x" -> "amazon.in". Accepts a bare domain or a URL. */
function normaliseDomain(value) {
  if (typeof value !== 'string') return null;
  let v = value.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].split(':')[0];
  v = v.replace(/^www\./, '').replace(/\.$/, '');
  return v || null;
}

function hostOf(value) {
  if (!value || typeof value !== 'string') return null;
  if (!value.includes('/')) return normaliseDomain(value);
  try {
    return normaliseDomain(new URL(value).hostname);
  } catch {
    return null;
  }
}

function matchesDomain(host, domain) {
  return !!host && (host === domain || host.endsWith('.' + domain));
}

/**
 * @param {Object[]} results  Already filtered by designSearch.service.
 * @param {Object}   [f]
 * @param {boolean}  [f.fullSizeOnly]    Drop results where only a small preview
 *                                       can be retrieved (Instagram, Facebook).
 * @param {number}   [f.minWidth]        Minimum width of the image you retrieve.
 * @param {string}   [f.orientation]     portrait | landscape | square
 * @param {string[]} [f.excludeDomains]  Drop these sites, including subdomains.
 * @returns {{ kept: Object[], removed: number, removedBy: Object }}
 */
function applyResultFilters(results, f = {}) {
  const exclude = (f.excludeDomains || []).map(normaliseDomain).filter(Boolean);
  const removedBy = { fullSizeOnly: 0, minWidth: 0, orientation: 0, excludeDomains: 0 };
  const kept = [];

  for (const r of results) {
    const fetchable = r.fetchable || {};

    if (f.fullSizeOnly && fetchable.from === 'thumbnailUrl') {
      removedBy.fullSizeOnly++;
      continue;
    }

    if (exclude.length) {
      const hosts = [hostOf(r.sourceDomain), hostOf(r.sourceUrl), hostOf(r.imageUrl)];
      if (exclude.some((d) => hosts.some((h) => matchesDomain(h, d)))) {
        removedBy.excludeDomains++;
        continue;
      }
    }

    if (f.minWidth && !(Number.isFinite(fetchable.width) && fetchable.width >= f.minWidth)) {
      removedBy.minWidth++;
      continue;
    }

    if (f.orientation && orientationOf(fetchable.width, fetchable.height) !== f.orientation) {
      removedBy.orientation++;
      continue;
    }

    kept.push(r);
  }

  const removed = results.length - kept.length;
  return { kept, removed, removedBy };
}

module.exports = { applyResultFilters, orientationOf, normaliseDomain };
