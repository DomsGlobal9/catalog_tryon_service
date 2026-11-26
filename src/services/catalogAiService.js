const { getDynamicPrompt, getRecolourPassPrompt } = require('../config/sys-constants-catalog');
const { ENVIRONMENTS, VARIANT_ENVIRONMENT } = require('../config/environments-catalog');
const sharp = require('sharp');

// =============================================================================
// COLOUR VARIANTS
// =============================================================================
// "The same saree, in another colour." Two ways to make the front view:
//
//   front (default)  the recolour rule is part of the front prompt, so the
//                    front is made in the new colour in one call. Same cost as
//                    a normal catalog: 4 image calls.
//   pass             the front is made as usual, then a second call recolours
//                    that finished photograph. Holds design detail best; costs
//                    one extra image call. Switch to it if the default lets
//                    colour leak into the zari or drift the motifs.
//
// Either way the back, side and sitting views are made from the finished
// front and carry no colour instruction of their own: one source of truth.
const COLOUR_VARIANT_MODE = (process.env.COLOUR_VARIANT_MODE || 'front').trim().toLowerCase() === 'pass' ? 'pass' : 'front';

/**
 * The background for this generation. A colour variant pins it: the random
 * prop would put each colour of the same saree in a different room.
 */
function pickEnvironment(colour) {
  if (colour) return VARIANT_ENVIRONMENT;
  return ENVIRONMENTS[Math.floor(Math.random() * ENVIRONMENTS.length)];
}

// Caller links are downloaded through lib/fetchImage: public addresses only,
// time and size capped, cancellable.
const { imageUrlToBase64, ImageFetchError } = require('../lib/fetchImage');
const { providerLimitError } = require('../lib/publicError');
const { aiLog, withContext, secondsSince } = require('../lib/stepLog');
const { quotaWaitMs } = require('../lib/aiLimits');

// =============================================================================
// BASE MODEL CACHE
// =============================================================================
// The four base poses are identical for every request using the same modelId,
// yet were re-downloaded and re-processed each time - measured at 10.7s per
// generation, of which 3.6s was download and only 159ms was sharp. Caching the
// PROCESSED base64 removes that from the critical path entirely.
//
// The promise is cached rather than the value, so two concurrent requests for
// the same model do the work once instead of racing. A rejected promise is
// evicted so a transient download failure is never cached.
const BASE_MODEL_CACHE_MAX = Number(process.env.BASE_MODEL_CACHE_MAX || 24);
const baseModelCache = new Map();

function prepareBaseModel(url) {
  if (baseModelCache.has(url)) {
    // Refresh recency for the LRU eviction below.
    const hit = baseModelCache.get(url);
    baseModelCache.delete(url);
    baseModelCache.set(url, hit);
    return hit;
  }

  const pending = (async () => augmentedResize(await imageUrlToBase64(url)))();
  pending.catch(() => baseModelCache.delete(url));

  baseModelCache.set(url, pending);
  while (baseModelCache.size > BASE_MODEL_CACHE_MAX) {
    const oldest = baseModelCache.keys().next().value;
    if (oldest === undefined) break;
    baseModelCache.delete(oldest);
  }
  return pending;
}

/**
 * Helper: Strip data URI prefix if present
 */
function cleanBase64(b64) {
  if (b64.startsWith('data:image')) {
    return b64.split(',')[1];
  }
  return b64;
}

// Upload format for every image we send to Gemini.
//
// This used to be PNG, which is lossless but enormous: one processed 1024px
// image is 1137 KB as PNG against 125 KB as JPEG q95 - 89% smaller. The front
// view uploads a base model AND the garment, so it was pushing ~3 MB of base64
// per call before generation could even start, on every view.
//
// q95 at 1024px is visually near-lossless and Gemini re-encodes internally
// anyway. Set INPUT_IMAGE_FORMAT=png to restore the original behaviour.
const INPUT_FORMAT = (process.env.INPUT_IMAGE_FORMAT || 'jpeg').toLowerCase();
const INPUT_QUALITY = Number(process.env.INPUT_IMAGE_QUALITY || 95);
const INPUT_MIME = INPUT_FORMAT === 'png' ? 'image/png' : 'image/jpeg';

/**
 * Augmented resize: tiny 1% crop + imperceptible brightness shift breaks Gemini's
 * AI-generated image detection fingerprint that can cause IMAGE_OTHER safety blocks.
 */
async function augmentedResize(base64Str) {
  if (!base64Str) return null;
  const cleaned = cleanBase64(base64Str);
  const inputBuffer = Buffer.from(cleaned, 'base64');
  const meta = await sharp(inputBuffer).metadata();
  const cropPx = Math.max(1, Math.floor(Math.min(meta.width || 512, meta.height || 512) * 0.01));
  const outputBuffer = await sharp(inputBuffer)
    .extract({
      left: cropPx,
      top: cropPx,
      width: (meta.width || 512) - cropPx * 2,
      height: (meta.height || 512) - cropPx * 2,
    })
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .modulate({ brightness: 1.02, saturation: 0.98 })
    .toFormat(INPUT_FORMAT, INPUT_FORMAT === 'jpeg' ? { quality: INPUT_QUALITY } : {})
    .toBuffer();
  return outputBuffer.toString('base64');
}

// OUTPUT SHAPE. Without this the image model picks the shape of whichever base
// photo it was given: most are 3:4, but the kurti and sharara poses are 2:3 and
// some lehenga and anarkali poses are 4:5, and one saree set came back with a
// 2:3 back view among 3:4 views. A product page wants every view the same shape.
// CATALOG_ASPECT_RATIO=off restores "follow the base photo".
const ASPECT_RATIOS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
function catalogAspectRatio() {
  const raw = String(process.env.CATALOG_ASPECT_RATIO || '').trim().toLowerCase();
  if (raw === 'off') return null;
  if (!raw) return '3:4';
  if (ASPECT_RATIOS.has(raw)) return raw;
  console.warn(`[Catalog] CATALOG_ASPECT_RATIO="${raw}" is not a supported ratio; using 3:4.`);
  return '3:4';
}

/**
 * Helper: Call Gemini 3.1 Flash Image Generation
 */
async function callGeminiImageGen(partsArray, abortSignal) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set in .env');

  // GEMINI_BASE_URL lets a test point this at a local stub, so an end-to-end
  // run of the pipeline costs nothing. Unset in production.
  const GEMINI_BASE = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const GEMINI_URL = `${GEMINI_BASE}/v1beta/models/gemini-3.1-flash-image:generateContent`;

  const aspectRatio = catalogAspectRatio();
  const payload = {
    contents: [ { parts: partsArray } ],
    generationConfig: {
      temperature: 0.1, // Low temperature for high consistency
      ...(aspectRatio ? { imageConfig: { aspectRatio } } : {})
    }
  };

  // Wall-clock ceiling for a single Gemini call. Without this a hung upstream
  // holds the worker open until the client happens to disconnect.
  // A view answers in about 14 s; a hung call is retried after 60 s, not 120 (19 Nov 2026: speed).
  const CALL_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 60000);

  let respJson;
  let retries = 3;
  let delay = 2000;
  const TRIES = retries;
  let quotaRetried = false;
  const tryNo = () => TRIES - retries + 1;
  const callStarted = Date.now();

  while (retries > 0) {
    // Abort on EITHER the client cancelling or our own timeout.
    const timeoutSignal = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;

    try {
      const resp = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify(payload),
        signal
      });

      if (resp.status === 503 || resp.status === 429) {
        const errText = await resp.text();
        const limit = providerLimitError(resp.status, errText);
        if (limit) {
          // Asked once more after a wait: measured 19 Nov, limit refusals came and went in minutes (lib/aiLimits.js).
          if (!quotaRetried) {
            quotaRetried = true;
            const wait = quotaWaitMs(errText);
            aiLog({ call: 'catalog-image', attempt: tryNo(), of: TRIES, result: 'retrying', reason: `Gemini usage limit reached (HTTP ${resp.status})`, waitSeconds: wait / 1000, why: 'a limit refusal often clears within minutes' });
            await new Promise(res => setTimeout(res, wait));
            if (abortSignal && abortSignal.aborted) throw new Error('AbortError: Generation cancelled by client');
            continue;
          }
          aiLog({ call: 'catalog-image', attempt: tryNo(), of: TRIES, result: 'failed', reason: `Gemini usage limit reached (HTTP ${resp.status}), twice`, why: 'the AI account limit needs raising' });
          throw limit;
        }
        const last = retries <= 1;
        aiLog({ call: 'catalog-image', attempt: tryNo(), of: TRIES, result: last ? 'gave_up' : 'retrying', reason: `busy (HTTP ${resp.status})`, waitSeconds: last ? null : delay / 1000 });
        if (last) { const busy = new Error(`Gemini API Error: HTTP ${resp.status} - ${errText}`); busy.logged = true; retries--; throw busy; }
        retries--;
        if (retries === 0) throw new Error(`Gemini API Error: HTTP ${resp.status} - ${errText}`);
        await new Promise(res => setTimeout(res, delay));
        delay *= 2; // Exponential backoff
        continue; // Retry
      }

      if (!resp.ok) {
        const errText = await resp.text();
        aiLog({ call: 'catalog-image', attempt: tryNo(), of: TRIES, result: 'failed', reason: `HTTP ${resp.status} ${errText.slice(0, 100)}`, why: 'a refused request is not retried' });
        const refused = new Error(`Gemini API Error: HTTP ${resp.status} - ${errText}`);
        refused.logged = true;
        throw refused;
      }

      // CRITICAL: read the body INSIDE the retry block.
      //
      // This used to sit after the loop, so the request was retried three times
      // but reading the response was not retried at all. Gemini image responses
      // are multiple megabytes of base64, which makes the body read the single
      // most likely point for the connection to drop - and a reset there
      // (TypeError: terminated / ECONNRESET) killed the whole 4-view job with
      // zero retries. Observed failing 2 of 2 end-to-end runs.
      respJson = await resp.json();

      // Success
      if (tryNo() > 1) aiLog({ call: 'catalog-image', attempt: tryNo(), of: TRIES, result: 'ok_after_retry', seconds: secondsSince(callStarted) });
      break;

    } catch (err) {
      // A genuine client cancellation must not be retried.
      if (abortSignal && abortSignal.aborted) throw err;
      const message = (err && err.message) || String(err);
      if (err && err.name === 'AbortError' && !(err.name === 'TimeoutError')) throw err;
      if (message.includes('AbortError')) throw err;
      // retries <= 1: the last 503/429 has already counted itself down to 0; its real
      // error used to be swallowed here and reported as "no response after retries".
      if (retries <= 1 || message.includes('HTTP 400') || (err && err.code === 'PROVIDER_LIMIT_REACHED')) {
        if (!(err && err.logged) && !(err && err.code === 'PROVIDER_LIMIT_REACHED')) aiLog({ call: 'catalog-image', attempt: tryNo(), of: TRIES, result: retries <= 1 ? 'gave_up' : 'failed', reason: message.slice(0, 140) });
        throw err;
      }
      aiLog({ call: 'catalog-image', attempt: tryNo(), of: TRIES, result: 'retrying', reason: message.slice(0, 140), waitSeconds: delay / 1000 });
      retries--;
      await new Promise(res => setTimeout(res, delay));
      delay *= 2;
    }
  }

  if (!respJson) throw new Error('Gemini API produced no response after retries.');
  const candidates = respJson.candidates;
  
  if (!candidates || candidates.length === 0) {
    throw new Error('Gemini API returned no candidates.');
  }

  const partsOut = candidates[0]?.content?.parts || [];
  
  // Bulletproof extraction
  let extractedBase64 = null;
  let extractedMime = "image/jpeg";
  
  // Method 1: Proper object traversal
  for (const p of partsOut) {
    const inlineObj = p.inline_data || p.inlineData;
    if (inlineObj && inlineObj.data) {
      extractedBase64 = inlineObj.data;
      extractedMime = inlineObj.mime_type || inlineObj.mimeType || "image/jpeg";
      break;
    }
  }
  
  // Method 2: Regex fallback if the object structure is somehow weird
  if (!extractedBase64) {
    const rawStr = JSON.stringify(partsOut);
    const dataMatch = rawStr.match(/"data"\s*:\s*"([^"]+)"/);
    const mimeMatch = rawStr.match(/"mimeType"\s*:\s*"([^"]+)"/);
    const altMimeMatch = rawStr.match(/"mime_type"\s*:\s*"([^"]+)"/);
    if (dataMatch && dataMatch[1]) {
      extractedBase64 = dataMatch[1];
      if (mimeMatch && mimeMatch[1]) extractedMime = mimeMatch[1];
      else if (altMimeMatch && altMimeMatch[1]) extractedMime = altMimeMatch[1];
    }
  }

  if (extractedBase64) {
    return `data:${extractedMime};base64,${extractedBase64}`;
  } else {
    const textPart = partsOut.find(p => p.text);
    const textReturned = textPart ? textPart.text : JSON.stringify(partsOut);
    console.error('\n❌ GEMINI API RETURNED TEXT INSTEAD OF AN IMAGE:');
    console.error(textReturned);
    console.error('\n');
    throw new Error(`Gemini API returned text but no image data. Reason: ${textReturned.substring(0, 100)}...`);
  }
}

/**
 * One garment image (a public link or base64) made ready for the image model: downloaded through
 * lib/fetchImage, then the augmented resize. Returns raw base64 (INPUT_MIME), or null for no input.
 */
async function prepareGarment(input, abortSignal) {
  if (!input) return null;
  if (typeof input !== 'string') throw new ImageFetchError('Garment images must be an image link or a base64 string.', 'INVALID_IMAGE');
  const cleanInput = input.trim();
  const isUrl = cleanInput.startsWith('http://') || cleanInput.startsWith('https://');
  if (isUrl) console.log('Downloading external image URL for input garment...');
  const raw = isUrl ? await imageUrlToBase64(cleanInput, { signal: abortSignal }) : cleanInput;
  try {
    return await augmentedResize(raw);
  } catch {
    throw new ImageFetchError('A garment image could not be read. Send a JPEG, PNG or WebP image.', 'INVALID_IMAGE');
  }
}

/**
 * The saree, blouse, extra saree photos and an earlier front view, prepared side by side.
 * Raw base64 for saree/blouse/extras (what generate4ViewCatalog takes); front as a data URI.
 */
async function prepareInputs({ saree, blouse = null, extras = [], front = null }, abortSignal) {
  // With up to six photos in one request, a refusal names the photo (production, 26 Nov: "An image
  // link could not be downloaded" left the caller guessing which of them was meant).
  const named = (label, input) => prepareGarment(input, abortSignal).catch((err) => {
    if (err && err.expose && typeof err.message === 'string' && !err.named) {
      err.message = `${label}: ${err.message.charAt(0).toLowerCase()}${err.message.slice(1)}`;
      err.named = true;
    }
    throw err;
  });
  const [s, b, f, ...x] = await Promise.all([
    named('The saree photo (saree)', saree),
    named('The blouse photo (blouse)', blouse),
    named('The front view (frontView)', front),
    ...extras.map((e, i) => named(`Extra photo ${i + 1} (sareeExtras)`, e))
  ]);
  return { saree: s, blouse: b, extras: x, front: f ? `data:${INPUT_MIME};base64,${f}` : null };
}

/** Raw base64 from prepareInputs as a data URI (what the product shots take). */
const toDataUri = (b64) => (b64 ? `data:${INPUT_MIME};base64,${cleanBase64(b64)}` : null);

/**
 * Executes the Sequential Generation Flow for the 4-view catalog.
 * Accepts Base64 inputs, returns Base64 outputs, and optionally yields progress events for SSE.
 */
async function generate4ViewCatalog(inputs, baseModels, onProgress, abortSignal) {
  try {
const {
  fullDress,
  topFront,
  bottom,
  category,
  dupattaStyleUrl,
  colour = null,
  // Optional: (front, { saree, blouse, extras }) => Promise, started as soon as the front view exists
  // and run beside the side and sitting views (the product shots). Must reject only on cancel.
  afterFront = null,
  // Optional: images the route has already prepared with prepareInputs() - { saree, blouse, extras } -
  // so they are not downloaded twice. extras = more photos of the SAME saree (pallu, border, close-up).
  prepared = null
} = inputs;
    console.log(`Starting Sequential Generation Flow for Category: ${category}${colour ? ` | colour variant: ${colour.name}${colour.hex ? ' ' + colour.hex : ''} (mode ${COLOUR_VARIANT_MODE})` : ''}`);

    // Select a random premium environment for this generation session
    // (pinned to one plain studio when a colour variant is requested).
    const randomEnv = pickEnvironment(colour);
    console.log(`Selected Dynamic Environment: ${randomEnv.substring(0, 60)}...`);

    // Base models: cached, and prepared concurrently on a cold cache. Was four
    // sequential download+resize round trips on every single request.
    // No back view (29 Oct): shops did not want it, so it is neither drawn nor paid for. A catalog
    // is front, side and sitting.
    const cacheWarm = [baseModels.front, baseModels.side, baseModels.sitting]
      .every((u) => baseModelCache.has(u));
    console.log(`Preparing Base Model Images (cache ${cacheWarm ? 'HIT' : 'MISS'})...`);
    const prepStarted = Date.now();
    const [frontBase, sideBase, sittingBase] = await Promise.all([
      prepareBaseModel(baseModels.front),
      prepareBaseModel(baseModels.side),
      prepareBaseModel(baseModels.sitting)
    ]);
    console.log(`   Base models ready in ${Date.now() - prepStarted}ms`);

    // Process input garments to bypass filters (supports both Base64 and public URLs)
    const resolveInput = (input) => prepareGarment(input, abortSignal);

    // Independent of each other - prepare concurrently. Images the route prepared are used as they are.
    const [processedFullDress, processedTopFront, processedBottom] = await Promise.all([
      prepared && prepared.saree ? prepared.saree : resolveInput(fullDress),
      prepared && prepared.saree ? (prepared.blouse || null) : resolveInput(topFront),
      resolveInput(bottom)
    ]);
    const processedExtras = (prepared && prepared.extras) || [];
    let processedDupattaStyle = null;

if (category === 'LEHANGA' && dupattaStyleUrl) {
  console.log('[Lehenga] Processing selected Dupatta Style reference...');

  processedDupattaStyle = await augmentedResize(
    await imageUrlToBase64(dupattaStyleUrl, { signal: abortSignal })
  );
}

    // Helper to build the exact sequence of images with inline text labels
const buildPayloadParts = (
  promptText,
  baseImage,
  referenceImage = null,
  includeDupattaReference = false
) => {
      const parts = [ { text: promptText } ];

      // ONLY include flat-lays if we are generating the Anchor (Front) view.
      // If a referenceImage exists, we want to hide the flat-lays so Gemini doesn't get confused.
      if (!referenceImage) {
        if (processedFullDress) {
          parts.push({ text: "GARMENT REFERENCE — The primary outfit to wear (Saree/Dress/Suit):" });
          parts.push({ inline_data: { mime_type: INPUT_MIME, data: cleanBase64(processedFullDress) } });
        }
        if (includeDupattaReference && processedDupattaStyle) {
  parts.push({
    text: "DUPATTA DRAPE STYLE REFERENCE — Reproduce this exact dupatta draping style, including shoulder placement, pleats, direction, fall, length, and overall arrangement. Do not invent a different dupatta style."
  });

  parts.push({
    inline_data: {
      mime_type: INPUT_MIME,
      data: cleanBase64(processedDupattaStyle)
    }
  });
}

        // More photos of the same saree (owner, 26 Nov): the pallu and border are copied, not guessed.
        processedExtras.forEach((extra, i) => {
          // With a colour variant the extra photos are in the OLD colour: they give the design only.
          const what = colour
            ? 'Copy its pallu and border DESIGN exactly, but NOT its colours: the colours follow the colour instruction above'
            : 'Copy these details exactly';
          parts.push({ text: `SAREE DETAIL ${i + 1} — another photo of the SAME saree (its pallu, border or a close-up). ${what}; it is not a second garment:` });
          parts.push({ inline_data: { mime_type: INPUT_MIME, data: cleanBase64(extra) } });
        });

        if (processedTopFront) {
          parts.push({ text: "BLOUSE REFERENCE — The blouse to wear under the saree (use this exact neckline, sleeves, fabric, and embroidery):" });
          parts.push({ inline_data: { mime_type: INPUT_MIME, data: cleanBase64(processedTopFront) } });
        }

        if (processedBottom) {
          parts.push({ text: "BOTTOM REFERENCE — The skirt/pants to wear:" });
          parts.push({ inline_data: { mime_type: INPUT_MIME, data: cleanBase64(processedBottom) } });
        }
      }

      if (referenceImage) {
        parts.push({ text: "CONSISTENCY LOCK — The Generated Front-View Reference (You MUST perfectly replicate the exact borders, colors, and draping style seen in this image):" });
        parts.push({ inline_data: { mime_type: INPUT_MIME, data: cleanBase64(referenceImage) } });
      }

      parts.push({ text: "CUSTOMER — The Base Model (The person to dress - PRESERVE THEIR EXACT IDENTITY, POSE, POSITION IN THE FRAME, CAMERA DISTANCE AND BACKGROUND):" });
      parts.push({ inline_data: { mime_type: INPUT_MIME, data: cleanBase64(baseImage) } });

      return parts;
    };

    const inputSlots = {
      hasFullDress: !!fullDress,
      hasTop: !!topFront,
      hasBottom: !!bottom,
      hasReference: false
    };

    // 1. Generate Front View (Anchor)
    console.log('Generating Front View...');
    if (abortSignal?.aborted) throw new Error('AbortError: Generation cancelled by client');
    // In 'front' mode the colour rule is part of this prompt. In 'pass' mode
    // the front is made in the reference's own colour and recoloured next.
    const frontColour = colour && COLOUR_VARIANT_MODE === 'front' ? colour : null;
    const frontPrompt = getDynamicPrompt('FRONT', category, inputSlots, randomEnv, { colour: frontColour });
   const frontParts = buildPayloadParts(
  frontPrompt,
  frontBase,
  null,
  category === 'LEHANGA' && !!processedDupattaStyle
);
    let generatedFront = await withContext({ item: 'front' }, () => callGeminiImageGen(frontParts, abortSignal));
    console.log('✅ Front View generated successfully.');

    if (colour && COLOUR_VARIANT_MODE === 'pass') {
      if (abortSignal?.aborted) throw new Error('AbortError: Generation cancelled by client');
      console.log(`Recolouring the front view to ${colour.name}...`);
      if (onProgress) onProgress({ type: 'status', message: `Recolouring the front view to ${colour.name}...` });
      const mime = (generatedFront.match(/^data:([^;]+);/) || [])[1] || 'image/jpeg';
      generatedFront = await withContext({ item: 'front-recolour' }, () => callGeminiImageGen([
        { text: getRecolourPassPrompt(colour, category) },
        { text: 'PHOTOGRAPH — the catalogue photograph to recolour (keep everything but the base fabric colour exactly as it is):' },
        { inline_data: { mime_type: mime, data: cleanBase64(generatedFront) } }
      ], abortSignal));
      console.log('✅ Front View recoloured successfully.');
    }

    if (onProgress) onProgress({ view: 'front', image: generatedFront });

    // Extra work that needs only the finished front (product shots) starts now, beside the views.
    // Guarded so a cancel while the views are still running is never an unhandled rejection.
    const asDataUri = (b64) => (b64 ? `data:${INPUT_MIME};base64,${cleanBase64(b64)}` : null);
    const extraWork = afterFront
      ? Promise.resolve().then(() => afterFront(generatedFront, { saree: asDataUri(processedFullDress), blouse: asDataUri(processedTopFront), extras: processedExtras.map(asDataUri) }))
      : null;
    if (extraWork) extraWork.catch(() => {});

    // 2. Generate Dependent Views (passing the generatedFront as a reference)
    console.log('Generating Dependent Views (Side, Sitting) using Front as reference...');
    
    // For strict consistency, we hide the flat-lays from the prompt builder so it strictly relies on the reference lock
    inputSlots.hasReference = true; 
    inputSlots.hasFullDress = false;
    inputSlots.hasTop = false;
    inputSlots.hasBottom = false;

    // The dependent views each reference ONLY the generated front view -
    // never each other - so there is no ordering constraint between them.
    // They used to run in series at ~14s each; concurrently they cost roughly
    // one view's time instead of two.
    //
    // They were originally serialised to avoid Gemini 503 "Deadline Exceeded".
    // That predates the retry-with-backoff in callGeminiImageGen, which now
    // absorbs 429/503 and connection resets. PARALLEL_VIEWS=false restores the
    // old behaviour if the failure rate ever justifies it.
    if (abortSignal?.aborted) throw new Error('AbortError: Generation cancelled by client');

    const runView = async (viewKey, viewName, baseImage) => {
      const image = await withContext({ item: viewKey }, () => callGeminiImageGen(
        buildPayloadParts(getDynamicPrompt(viewName, category, inputSlots, randomEnv), baseImage, generatedFront),
        abortSignal
      ));
      console.log(`✅ ${viewName} View generated successfully.`);
      // Fired the moment each view lands, so the client still streams results
      // as they arrive rather than waiting for the slowest of them.
      if (onProgress) onProgress({ view: viewKey, image });
      return image;
    };

    const views = [
      ['side', 'SIDE', sideBase],
      ['sitting', 'SITTING', sittingBase]
    ];

    const dependentStarted = Date.now();
    let generatedSide, generatedSitting;

    if (process.env.PARALLEL_VIEWS === 'false') {
      const out = [];
      for (const [k, n, b] of views) out.push(await runView(k, n, b));
      [generatedSide, generatedSitting] = out;
    } else {
      [generatedSide, generatedSitting] =
        await Promise.all(views.map(([k, n, b]) => runView(k, n, b)));
    }

    console.log(`✅ All Dependent Views generated successfully in ${Date.now() - dependentStarted}ms.`);

    const extra = extraWork ? await extraWork : undefined;

    return {
      front: generatedFront,
      side: generatedSide,
      sitting: generatedSitting,
      ...(extraWork ? { extra } : {})
    };

  } catch (error) {
    console.error('AI Generation Failed:', error);
    throw error;
  }
}

module.exports = {
  generate4ViewCatalog,
  prepareGarment,
  prepareInputs,
  toDataUri,
  catalogAspectRatio,
  pickEnvironment,
  COLOUR_VARIANT_MODE,
  // Exported so the retry behaviour can be pinned by a test. The response body
  // read sits inside the retry loop; a dropped download must be retried, not
  // fatal, and that is worth regression coverage rather than trust.
  callGeminiImageGen
};
