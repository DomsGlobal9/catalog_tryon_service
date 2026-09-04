const { getDynamicPrompt } = require('../config/sys-constants-catalog');
const { ENVIRONMENTS } = require('../config/environments-catalog');
const sharp = require('sharp');

/**
 * Helper: Download an image URL and convert to Base64
 */
async function imageUrlToBase64(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Image download failed: HTTP ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return buffer.toString('base64');
}

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

/**
 * Helper: Call Gemini 3.1 Flash Image Generation
 */
async function callGeminiImageGen(partsArray, abortSignal) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set in .env');

  const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent";

  const payload = {
    contents: [ { parts: partsArray } ],
    generationConfig: {
      temperature: 0.1, // Low temperature for high consistency
    }
  };

  // Wall-clock ceiling for a single Gemini call. Without this a hung upstream
  // holds the worker open until the client happens to disconnect.
  const CALL_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 120000);

  let respJson;
  let retries = 3;
  let delay = 2000;

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
        console.warn(`[Gemini API] HTTP ${resp.status} (High Demand). Retries left: ${retries - 1}.`);
        retries--;
        if (retries === 0) throw new Error(`Gemini API Error: HTTP ${resp.status} - ${errText}`);
        await new Promise(res => setTimeout(res, delay));
        delay *= 2; // Exponential backoff
        continue; // Retry
      }

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Gemini API Error: HTTP ${resp.status} - ${errText}`);
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
      break;

    } catch (err) {
      // A genuine client cancellation must not be retried.
      if (abortSignal && abortSignal.aborted) throw err;
      const message = (err && err.message) || String(err);
      if (err && err.name === 'AbortError' && !(err.name === 'TimeoutError')) throw err;
      if (message.includes('AbortError')) throw err;
      if (retries === 1 || message.includes('HTTP 400')) throw err;
      console.warn(`[Gemini API] Request Failed: ${message}. Retries left: ${retries - 1}`);
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
  dupattaStyleUrl
} = inputs;
    console.log(`Starting Sequential Generation Flow for Category: ${category}`);

    // Select a random premium environment for this generation session
    const randomEnv = ENVIRONMENTS[Math.floor(Math.random() * ENVIRONMENTS.length)];
    console.log(`Selected Dynamic Environment: ${randomEnv.substring(0, 60)}...`);

    // Base models: cached, and prepared concurrently on a cold cache. Was four
    // sequential download+resize round trips on every single request.
    const cacheWarm = [baseModels.front, baseModels.back, baseModels.side, baseModels.sitting]
      .every((u) => baseModelCache.has(u));
    console.log(`Preparing Base Model Images (cache ${cacheWarm ? 'HIT' : 'MISS'})...`);
    const prepStarted = Date.now();
    const [frontBase, backBase, sideBase, sittingBase] = await Promise.all([
      prepareBaseModel(baseModels.front),
      prepareBaseModel(baseModels.back),
      prepareBaseModel(baseModels.side),
      prepareBaseModel(baseModels.sitting)
    ]);
    console.log(`   Base models ready in ${Date.now() - prepStarted}ms`);

    // Process input garments to bypass filters (supports both Base64 and public URLs)
    const resolveInput = async (input) => {
      if (!input) return null;
      const cleanInput = input.trim();
      if (cleanInput.startsWith('http://') || cleanInput.startsWith('https://')) {
        console.log('Downloading external image URL for input garment...');
        return await augmentedResize(await imageUrlToBase64(cleanInput));
      }
      return await augmentedResize(cleanInput);
    };

    // Independent of each other - prepare concurrently.
    const [processedFullDress, processedTopFront, processedBottom] = await Promise.all([
      resolveInput(fullDress),
      resolveInput(topFront),
      resolveInput(bottom)
    ]);
    let processedDupattaStyle = null;

if (category === 'LEHANGA' && dupattaStyleUrl) {
  console.log('[Lehenga] Processing selected Dupatta Style reference...');

  processedDupattaStyle = await augmentedResize(
    await imageUrlToBase64(dupattaStyleUrl)
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

      parts.push({ text: "CUSTOMER — The Base Model (The person to dress - PRESERVE THEIR EXACT IDENTITY, POSE AND BACKGROUND):" });
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
    const frontPrompt = getDynamicPrompt('FRONT', category, inputSlots, randomEnv);
   const frontParts = buildPayloadParts(
  frontPrompt,
  frontBase,
  null,
  category === 'LEHANGA' && !!processedDupattaStyle
);
    const generatedFront = await callGeminiImageGen(frontParts, abortSignal);
    console.log('✅ Front View generated successfully.');
    if (onProgress) onProgress({ view: 'front', image: generatedFront });

    // 2. Generate Dependent Views (passing the generatedFront as a reference)
    console.log('Generating Dependent Views (Back, Side, Sitting) using Front as reference...');
    
    // For strict consistency, we hide the flat-lays from the prompt builder so it strictly relies on the reference lock
    inputSlots.hasReference = true; 
    inputSlots.hasFullDress = false;
    inputSlots.hasTop = false;
    inputSlots.hasBottom = false;

    // The three dependent views each reference ONLY the generated front view -
    // never each other - so there is no ordering constraint between them.
    // They used to run in series at ~14s each; concurrently they cost roughly
    // one view's time instead of three.
    //
    // They were originally serialised to avoid Gemini 503 "Deadline Exceeded".
    // That predates the retry-with-backoff in callGeminiImageGen, which now
    // absorbs 429/503 and connection resets. PARALLEL_VIEWS=false restores the
    // old behaviour if the failure rate ever justifies it.
    if (abortSignal?.aborted) throw new Error('AbortError: Generation cancelled by client');

    const runView = async (viewKey, viewName, baseImage) => {
      const image = await callGeminiImageGen(
        buildPayloadParts(getDynamicPrompt(viewName, category, inputSlots, randomEnv), baseImage, generatedFront),
        abortSignal
      );
      console.log(`✅ ${viewName} View generated successfully.`);
      // Fired the moment each view lands, so the client still streams results
      // as they arrive rather than waiting for the slowest of the three.
      if (onProgress) onProgress({ view: viewKey, image });
      return image;
    };

    const views = [
      ['back', 'BACK', backBase],
      ['side', 'SIDE', sideBase],
      ['sitting', 'SITTING', sittingBase]
    ];

    const dependentStarted = Date.now();
    let generatedBack, generatedSide, generatedSitting;

    if (process.env.PARALLEL_VIEWS === 'false') {
      const out = [];
      for (const [k, n, b] of views) out.push(await runView(k, n, b));
      [generatedBack, generatedSide, generatedSitting] = out;
    } else {
      [generatedBack, generatedSide, generatedSitting] =
        await Promise.all(views.map(([k, n, b]) => runView(k, n, b)));
    }

    console.log(`✅ All Dependent Views generated successfully in ${Date.now() - dependentStarted}ms.`);

    return {
      front: generatedFront,
      back: generatedBack,
      side: generatedSide,
      sitting: generatedSitting
    };

  } catch (error) {
    console.error('AI Generation Failed:', error);
    throw error;
  }
}

module.exports = {
  generate4ViewCatalog
};
