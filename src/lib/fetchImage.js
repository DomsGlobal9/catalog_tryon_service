// =============================================================================
// fetchImage.js — download a caller's image link safely.
// =============================================================================
//
// The catalog endpoints accept any public image link (a shop's CDN, a Discovery
// result on Pinterest or Instagram), so a host allowlist like Design Studio's
// would break callers. Instead every download is held to:
//
//   * http or https only;
//   * a PUBLIC internet address. The check runs on the address actually
//     connected to (inside the DNS lookup), so a name that resolves to
//     10.x / 127.x / 169.254.x - or changes its answer between check and
//     connect - is refused. Every redirect hop is checked the same way;
//   * a time limit for the whole download, body included;
//   * a size limit on the bytes actually received, not just the declared length;
//   * the caller's cancel signal, so a cancelled job stops downloading.
//
// Failures are ImageFetchError with a message safe to show the caller. The
// message is the same for "private address" and "does not exist", so it cannot
// be used to map internal hosts.
//
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const TIMEOUT_MS = Number(process.env.IMAGE_DOWNLOAD_TIMEOUT_MS || 20000);
const MAX_BYTES = Number(process.env.IMAGE_DOWNLOAD_MAX_MB || 15) * 1024 * 1024;
const MAX_REDIRECTS = 5;

class ImageFetchError extends Error {
  constructor(message, code = 'IMAGE_DOWNLOAD_FAILED') {
    super(message);
    this.name = 'ImageFetchError';
    this.code = code;
    this.status = 422;
    this.expose = true;
  }
}

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]
]) blocked.addSubnet(addr, prefix, 'ipv6');

function isPublicAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  const family = net.isIP(address);
  if (!family) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** dns.lookup that refuses non-public answers, so the connect cannot reach them. */
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
      const e = new Error(`${hostname} is not a public address`);
      e.code = 'ENOTPUBLIC';
      return callback(e);
    }
    if (options && options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

const unreachable = () => new ImageFetchError('An image link could not be downloaded. Use a public http(s) image link, or send the image as base64.');

function checkUrl(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImageFetchError('Image links must start with http:// or https://.', 'IMAGE_SOURCE_NOT_ALLOWED');
  }
  // An IP literal never goes through the lookup, so check it here.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !isPublicAddress(host)) throw unreachable();
}

function request(url, signal) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, { lookup: publicLookup, signal, headers: {
      Accept: 'image/*',
      // Raw bytes: unlike fetch(), http.get does not undo gzip.
      'Accept-Encoding': 'identity',
      // Some CDNs refuse a request with no User-Agent; fetch() always sent one.
      'User-Agent': 'Mozilla/5.0 (compatible; ScaleEzy-Catalog/1.0)'
    } }, resolve);
    req.on('error', reject);
  });
}

async function readCapped(res) {
  const declared = Number(res.headers['content-length']);
  if (declared > MAX_BYTES) {
    res.destroy();
    throw new ImageFetchError(`An image link points to a file larger than ${MAX_BYTES / 1024 / 1024} MB.`, 'IMAGE_TOO_LARGE');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res) {
    total += chunk.length;
    if (total > MAX_BYTES) {
      res.destroy();
      throw new ImageFetchError(`An image link points to a file larger than ${MAX_BYTES / 1024 / 1024} MB.`, 'IMAGE_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function downloadImage(rawUrl, { signal } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw new ImageFetchError('An image link is not a valid URL.', 'IMAGE_SOURCE_NOT_ALLOWED');
  }
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      checkUrl(url);
      const res = await request(url, combined);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        url = new URL(res.headers.location, url);
        continue;
      }
      if (res.statusCode !== 200) {
        res.resume();
        throw new ImageFetchError(`An image link could not be downloaded (HTTP ${res.statusCode}).`,
          res.statusCode === 404 || res.statusCode === 410 ? 'IMAGE_NOT_FOUND' : 'IMAGE_DOWNLOAD_FAILED');
      }
      const body = await readCapped(res);
      if (!body.length) throw new ImageFetchError('An image link returned an empty file.', 'INVALID_IMAGE');
      return body;
    }
    throw new ImageFetchError('An image link redirected too many times.');
  } catch (err) {
    // The caller cancelled: keep it an AbortError so the pipeline reports a cancel.
    if (signal && signal.aborted) {
      const abort = new Error('AbortError: image download cancelled');
      abort.name = 'AbortError';
      throw abort;
    }
    if (err instanceof ImageFetchError) throw err;
    if (timeout.aborted) {
      throw new ImageFetchError(`An image link did not download within ${TIMEOUT_MS / 1000}s.`, 'IMAGE_DOWNLOAD_TIMEOUT');
    }
    throw unreachable();
  }
}

/** The image as base64, the shape both catalog pipelines work in. */
async function imageUrlToBase64(url, options) {
  return (await downloadImage(url, options)).toString('base64');
}

module.exports = { downloadImage, imageUrlToBase64, isPublicAddress, ImageFetchError };
