// =============================================================================
// platforms.js — Which site a result came from, and how to search one site.
// =============================================================================
//
// There is no Pinterest, Instagram or Facebook API behind this. Every source is
// the same image search with a different query, and a result's platform is
// decided from its URLs. That is a deliberate choice, and the reason is measured:
//
//   * `site:pinterest.com …` returns ZERO results from this provider - for all
//     three platforms, on both the image and web endpoints.
//   * Adding the platform's name as an ordinary word works. Share of 50 results
//     from the target platform, averaged over two garments (Sept 2026):
//
//         instagram      "instagram"       80%     "instagram post"   72%
//         pinterest      "pinterest"       46%     "pinterest ideas"  48%
//         facebook       "facebook page"   40%     "facebook"         17%
//
//     The words below are the winners. "facebook page" more than doubles the
//     Facebook hit rate over the bare name; the other two differences are noise,
//     so the simpler word is kept.
//
// Scraping these platforms directly is not an option: it breaks their terms,
// needs logged-in accounts, and is blocked quickly.
//

/** Everything a caller may put in `sources`. `web` is today's behaviour. */
const SOURCES = ['web', 'pinterest', 'instagram', 'facebook'];

/** Words appended to the query for a platform source. `web` adds nothing. */
const SOURCE_QUERY_TERMS = {
  web: [],
  pinterest: ['pinterest'],
  instagram: ['instagram'],
  facebook: ['facebook', 'page']
};

// Host patterns. Anchored on a dot or the start so that a shop called
// "pinterestsarees.com" is NOT mistaken for Pinterest.
const PLATFORM_HOSTS = {
  pinterest: [
    /(^|\.)pinterest\.(com|ca|de|fr|es|it|jp|at|ch|cl|dk|ie|nz|ph|pt|ru|se|co\.uk|com\.au|com\.mx|co\.kr|co\.in)$/,
    /(^|\.)pinimg\.com$/
  ],
  instagram: [/(^|\.)instagram\.com$/, /(^|\.)cdninstagram\.com$/],
  facebook: [/(^|\.)facebook\.com$/, /(^|\.)fb\.com$/, /(^|\.)fbsbx\.com$/, /(^|\.)fbcdn\.net$/]
};

function hostOf(value) {
  if (!value || typeof value !== 'string') return null;
  // sourceDomain arrives as a bare host; the URLs arrive as URLs.
  if (!value.includes('/')) return value.trim().toLowerCase();
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The platform a result belongs to: pinterest | instagram | facebook | web.
 *
 * Checks the image host, the source domain and the source page, because no one
 * of them is enough on its own - a Facebook result's image lives on
 * lookaside.fbsbx.com, which does not say "facebook".
 */
function platformOf(result) {
  if (!result) return 'web';
  const hosts = [result.imageUrl, result.sourceDomain, result.sourceUrl].map(hostOf).filter(Boolean);
  for (const [platform, patterns] of Object.entries(PLATFORM_HOSTS)) {
    if (hosts.some((h) => patterns.some((re) => re.test(h)))) return platform;
  }
  return 'web';
}

// ─────────────────────────────────────────────────────────────────────────────
// Pinterest image upgrade
// ─────────────────────────────────────────────────────────────────────────────
//
// The search index stores most Pinterest images at a small size - 136 of 208
// Pinterest results in one sample were `i.pinimg.com/236x/…`, 236 pixels wide.
// Our 400px minimum used to discard every one of them: for "lehenga border
// design pinterest" it removed 22 of 31 Pinterest results.
//
// Pinterest serves the same image at other sizes by changing that one path
// segment. Measured by downloading and decoding every image:
//
//     236x -> 736x   23/23 returned a real image, 20/23 at the full 736 width
//     474x -> 736x   15/15 returned a real image, 10/15 larger than before
//     236x -> originals   5/8  (3 refused with 403 - not used)
//
// So small sizes are rewritten to 736x. The 736x file is never smaller than the
// original, but it is not always 736 wide (a pin uploaded at 600px stays 600), so
// the size we report is an ESTIMATE and is flagged as one. The original URL is
// kept as `fallbackUrl` in case Pinterest ever stops serving the larger size.
//
const PINIMG_UPGRADE = /^(https?:\/\/i\.pinimg\.com\/)(236x|474x|564x)(\/)/i;
const PINIMG_TARGET_WIDTH = 736;

/**
 * @returns {{ url: string, width: number|null, height: number|null } | null}
 *          null when the URL is not a small Pinterest image.
 */
function upgradePinterestImage(result) {
  if (!result || typeof result.imageUrl !== 'string') return null;
  if (!PINIMG_UPGRADE.test(result.imageUrl)) return null;

  const url = result.imageUrl.replace(PINIMG_UPGRADE, `$1${PINIMG_TARGET_WIDTH}x$3`);
  const { width, height } = result;
  const known = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;

  return {
    url,
    width: known ? PINIMG_TARGET_WIDTH : null,
    height: known ? Math.round((PINIMG_TARGET_WIDTH * height) / width) : null
  };
}

module.exports = {
  SOURCES,
  SOURCE_QUERY_TERMS,
  platformOf,
  upgradePinterestImage,
  PINIMG_TARGET_WIDTH
};
