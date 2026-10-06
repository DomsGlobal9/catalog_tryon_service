const express = require("express");

const router = express.Router();

// A bad user photo is the caller's problem (400) and an upstream refusal is a
// dependency problem (424). Neither is a 5xx: the gateway's circuit breaker
// counts 5xx per slug, so returning 500 here could take the whole service
// offline for everyone including the women pipeline and discovery.
function statusFor(error) {
  const msg = (error && error.message) || '';
  if (error && error.expose && error.status) return error.status;
  if (/user photo is required|unable to read/i.test(msg)) return 400;
  if (/gemini|http 4\d\d|http 5\d\d/i.test(msg)) return 424;
  return 500;
}

// One request may ask for several sizes, and in mix-and-match several tops per
// size; each pair is one paid image. Without a ceiling, `sizes: ["S" x 500]`
// started 500 paid calls at once while counting as one generation.
// 50 fits every real request: the bundled frontend sends all 7 waist sizes at
// once, times each top uploaded for mix-and-match.
const MAX_IMAGES_PER_REQUEST = Number(process.env.MEN_MAX_IMAGES_PER_REQUEST || 50);
const SIZE_ADVICE_PER_HOUR = Number(process.env.SIZE_ADVICE_RATE_LIMIT_PER_HOUR || 120);




const {
  generateFrontCatalog
} = require("../services/menAiService");
const {
  recommendSizeFromPhoto,
  ALL_SIZES
} = require("../services/sizeRecommendationService");

const MEN_BODY_REFERENCE_URLS = {
  S: 'https://slvakgspnsyvpuakfmvb.supabase.co/storage/v1/object/public/body-references/body-references/size%20s.png',
  M: 'https://slvakgspnsyvpuakfmvb.supabase.co/storage/v1/object/public/body-references/body-references/size%20m.png',
  L: 'https://slvakgspnsyvpuakfmvb.supabase.co/storage/v1/object/public/body-references/body-references/size%20l.png',
  XL: 'https://slvakgspnsyvpuakfmvb.supabase.co/storage/v1/object/public/body-references/body-references/size%20xl.png',
  XXL: 'https://slvakgspnsyvpuakfmvb.supabase.co/storage/v1/object/public/body-references/body-references/size%20xxl.png',
  XXXL: 'https://slvakgspnsyvpuakfmvb.supabase.co/storage/v1/object/public/body-references/body-references/size%20xxxl.png'
};

// Bottom wear uses its own body reference URLs keyed directly by waist size
const BOTTOM_WEAR_BODY_REFERENCE_URLS = {
  '28': 'https://slvakgspnsyvpuakfmvb.supabase.co/storage/v1/object/public/body-references/body-references/size%20s.png',
  '30': 'https://slvakgspnsyvpuakfmvb.supabase.co/storage/v1/object/public/body-references/body-references/size%20s.png',
  '32': 'https://slvakgspnsyvpuakfmvb.supabase.co/storage/v1/object/public/body-references/body-references/size%20m.png',
  '34': 'https://slvakgspnsyvpuakfmvb.supabase.co/storage/v1/object/public/body-references/body-references/size%20l.png',
  '36': 'https://slvakgspnsyvpuakfmvb.supabase.co/storage/v1/object/public/body-references/body-references/size%20xl.png',
  '38': 'https://slvakgspnsyvpuakfmvb.supabase.co/storage/v1/object/public/body-references/body-references/size%20xxl.png',
  '40': 'https://slvakgspnsyvpuakfmvb.supabase.co/storage/v1/object/public/body-references/body-references/size%20xxxl.png'
};


// ============================================================
// CONFIG
// ============================================================

// Authentication is handled once, app-wide, by requireServiceKey in
// src/index.js (`app.use('/api/', ...)`), which checks SERVICE_API_KEY.
//
// This file used to re-check a DIFFERENT variable (INTERNAL_API_KEY) with a
// hardcoded fallback committed to the repo. Two problems: the fallback key was
// public, and because it read a different variable, rotating SERVICE_API_KEY
// would have silently broken every men endpoint while the rest of the service
// kept working. The duplicate gate is removed rather than fixed - one place to
// get authentication right is better than two.


// ============================================================
// SIMPLE JOB STORE
// ============================================================

// Running jobs are tracked in middleware/generationGuard.js, shared with the
// women pipeline and visible to every server.
const { admitGeneration, cancelGeneration } = require("../middleware/generationGuard");
const { budgetKey } = require("../middleware/identity");
const shared = require("../lib/shared");
const { publicMessage } = require("../lib/publicError");


let previousJobs =
  0;


// ============================================================
// API KEY MIDDLEWARE
// ============================================================




// ============================================================
// HELPERS
// ============================================================

const STANDARD_SIZES = ["S", "M", "L", "XL", "XXL", "XXXL"];
const WAIST_SIZES = ["28", "30", "32", "34", "36", "38", "40"];

// Map numerical waist sizes to standard letter sizes for body references
const WAIST_TO_STANDARD_MAP = {
  '28': 'S', '30': 'S', '32': 'M', '34': 'L',
  '36': 'XL', '38': 'XXL', '40': 'XXXL'
};

function getMappedSize(size) {
  const s = String(size).toUpperCase();
  return WAIST_TO_STANDARD_MAP[s] || s;
}


// ============================================================
// SHARED: SSE GENERATION HANDLER
// ============================================================
//
// This is the core logic shared across all 3 endpoints.
// Each endpoint validates inputs and then calls this function.
//

async function runSSEGeneration(req, res, {
  clientId,
  full,
  topFront,
  bottom,
  tops,
  category,
  categoryGroup,
  userPhoto,
  validatedSizes,
  sizeType,
  useBodyReferences,
  modeName
}) {

  // --------------------------------------------------------
  // BUDGET, CANCEL PREVIOUS JOB, CAPACITY, CREATE JOB
  // --------------------------------------------------------
  // Shared with the women pipeline (middleware/generationGuard.js): the previous
  // job for this client is stopped on whichever server runs it, and a refusal is
  // a JSON 429 sent before the stream opens.

  if (typeof clientId === 'number') clientId = String(clientId);
  if (typeof clientId !== 'string' || !clientId.trim()) {
    return res.status(400).json({ error: "clientId must be text." });
  }
  // The same size twice is the same picture twice, paid twice.
  validatedSizes = [...new Set(validatedSizes)];
  const isMixAndMatch = categoryGroup === 'BOTTOM_WEAR' && Array.isArray(tops) && tops.length > 0;
  if (isMixAndMatch && !tops.every((t) => typeof t === 'string' && t.trim())) {
    return res.status(400).json({ error: "Every entry in tops must be an image link or base64 string." });
  }
  const imageCount = validatedSizes.length * (isMixAndMatch ? tops.length : 1);
  if (imageCount > MAX_IMAGES_PER_REQUEST) {
    return res.status(400).json({
      error: `This request would make ${imageCount} images; the most per request is ${MAX_IMAGES_PER_REQUEST}. Send fewer sizes or tops.`
    });
  }

  const admitted = await admitGeneration(req, res, { clientId, pipeline: 'men' });
  if (!admitted) return;

  const controller = admitted.job;
  previousJobs += 1;

  // The caller hung up: stop the paid calls nobody will receive. The response's
  // close, not the request's - Express 5 has finished reading the request.
  res.on('close', () => {
    if (!res.writableFinished && !controller.signal.aborted) controller.abort();
  });


  console.log("========================================");
  console.log(`MEN'S ${modeName} GENERATION STARTED`);
  console.log("Client:", clientId);
  console.log("Category:", category);
  console.log("Category Group:", categoryGroup);
  console.log("Sizes:", validatedSizes);
  console.log("Size Type:", sizeType);
  console.log("User Photo:", userPhoto ? "Yes" : "No");
  console.log("Body References:", useBodyReferences ? "Yes" : "No");
  console.log("Previous jobs:", previousJobs - 1);
  console.log("========================================");


  // --------------------------------------------------------
  // SSE HEADERS
  // --------------------------------------------------------

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const sendEvent = (data) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };


  // --------------------------------------------------------
  // STATUS
  // --------------------------------------------------------

  sendEvent({
    type: "STATUS",
    message: userPhoto
      ? `Preparing your photo for ${modeName.toLowerCase()} generation...`
      : `Preparing ${modeName.toLowerCase()} generation...`
  });


  try {
    const allResults = {};

    // --------------------------------------------------------
    // VALIDATE BODY REFERENCES (if needed)
    // --------------------------------------------------------

    if (useBodyReferences) {
      for (const size of validatedSizes) {
        let refUrl;
        if (categoryGroup === 'BOTTOM_WEAR') {
          refUrl = BOTTOM_WEAR_BODY_REFERENCE_URLS[String(size)];
        } else {
          const mappedSize = getMappedSize(size);
          refUrl = MEN_BODY_REFERENCE_URLS[mappedSize];
        }
        if (!refUrl) {
          console.error(`Missing body reference for size ${size}`);
          sendEvent({
            type: "ERROR",
            error: `Missing body reference for size ${size}`
          });
          res.end();
          return;
        }
      }
    }


    // --------------------------------------------------------
    // CONCURRENT GENERATION
    // --------------------------------------------------------

    const topsToProcess = isMixAndMatch ? tops : [null]; // If not mix and match, run once with null

    const generationJobs = [];

    for (const currentSize of validatedSizes) {
      for (let topIndex = 0; topIndex < topsToProcess.length; topIndex++) {
        const currentTop = topsToProcess[topIndex];
        
        generationJobs.push((async () => {
          if (controller.signal.aborted) {
            console.log(`Job cancelled for size ${currentSize}`);
            return;
          }

          sendEvent({
            type: "SIZE_STATUS",
            size: currentSize,
            status: "GENERATING"
          });

          try {
            // Set when the streaming callback below emits SIZE_READY, so the
            // post-await emit does not send the same image a second time.
            let streamedThisSize = false;
            let bodyReferenceUrl = null;

            if (useBodyReferences) {
              if (categoryGroup === 'BOTTOM_WEAR') {
                // Bottom wear: use dedicated waist-size URLs directly
                bodyReferenceUrl = BOTTOM_WEAR_BODY_REFERENCE_URLS[String(currentSize)];
                console.log('Selected Waist Size:', currentSize);
                console.log('Selected Bottom Wear Body Reference:', bodyReferenceUrl);
              } else {
                // Top wear: map to standard letter size
                const mappedSize = getMappedSize(currentSize);
                bodyReferenceUrl = MEN_BODY_REFERENCE_URLS[mappedSize];
                console.log('Selected Size:', currentSize, 'Mapped to:', mappedSize);
                console.log('Selected Body Reference:', bodyReferenceUrl);
              }
            }

            // In Mix and Match, `full` is the bottom. `currentTop` is the top.
            const generateFull = isMixAndMatch ? null : full;
            const generateBottom = isMixAndMatch ? (bottom || full) : bottom;
            const generateTopFront = isMixAndMatch ? currentTop : topFront;

            const result = await generateFrontCatalog(
              {
                fullDress: generateFull,
                topFront: generateTopFront,
                bottom: generateBottom,
                category,
                categoryGroup,
                userPhoto: userPhoto || null,
                size: currentSize,
                sizeType,
                bodyReferenceUrl
              },
              {},
              (progress) => {
                if (progress.image) {
                  streamedThisSize = true;
                  sendEvent({
                    type: "SIZE_READY",
                    size: progress.size || currentSize,
                    topIndex: isMixAndMatch ? topIndex : undefined,
                    result: progress.image
                  });
                }
              },
              controller.signal
            );

            if (!allResults[currentSize]) allResults[currentSize] = {};
            
            if (isMixAndMatch) {
              allResults[currentSize][topIndex] = result;
            } else {
              allResults[currentSize] = result;
            }

            // Fallback only. This used to fire unconditionally *in addition* to
            // the progress callback above, so every size was streamed twice as
            // byte-identical duplicates (confirmed by md5 against production).
            // The UI keys results by size so it silently overwrote itself, but a
            // third party appending to a list received every image twice.
            if (!streamedThisSize) {
              sendEvent({
                type: "SIZE_READY",
                size: currentSize,
                topIndex: isMixAndMatch ? topIndex : undefined,
                result: result
              });
            }
          } catch (error) {
            if (controller.signal.aborted) return; // reported once, below
            console.error(`Error generating size ${currentSize}:`, error);
            sendEvent({
              type: "ERROR",
              size: currentSize,
              error: publicMessage(error, `Size ${currentSize} could not be generated. Please try again.`)
            });
          }
        })());
      }
    }

    await Promise.allSettled(generationJobs);

    // Cancelled or replaced by a newer job: partial results are not a finished
    // catalog, so no COMPLETE.
    if (controller.signal.aborted) {
      sendEvent({ type: "ERROR", code: "CANCELLED", error: "Generation was cancelled." });
      return;
    }

    sendEvent({
      type: "COMPLETE",
      results: allResults,
      mode: userPhoto ? "USER_PHOTO" : "MODEL"
    });

    console.log(`MEN'S ${modeName} GENERATION COMPLETE`);

  } catch (error) {

    console.error(`MEN'S ${modeName} GENERATION ERROR:`, error);

    if (error.name === "AbortError" || controller.signal.aborted) {
      sendEvent({
        type: "ERROR",
        code: "CANCELLED",
        error: "Generation was cancelled."
      });
    } else {
      sendEvent({
        type: "ERROR",
        error: publicMessage(error)
      });
    }

  } finally {
    // Releases only this job. The old code deleted by clientId, so a replaced
    // job finishing late removed the NEW job's entry and made it uncancellable.
    await admitted.release();
    res.end();
  }
}


// ============================================================
// ANALYZE USER PHOTO AND RECOMMEND SIZE
// ============================================================

router.post(

  "/recommend-size",

  async (
    req,
    res
  ) => {

    try {

      const {
        userPhoto
      } = req.body;


      // ------------------------------------------------------
      // VALIDATE
      // ------------------------------------------------------

      if (!userPhoto) {

        return res.status(400).json({

          error:
            "User photo is required for size recommendation."

        });

      }


      // A paid Gemini call, so it has a budget like every generation (its own,
      // so asking for size advice never uses up a shop's generations).
      if (SIZE_ADVICE_PER_HOUR > 0) {
        const clientId = typeof req.body.clientId === 'string' ? req.body.clientId : 'men-frontend';
        const budget = await shared.rateLimiter.consume(`size-advice:${budgetKey(req, clientId)}`, 1,
          { limit: SIZE_ADVICE_PER_HOUR, windowSec: 3600 });
        if (!budget.allowed) {
          res.set('Retry-After', String(budget.retryAfterSec));
          return res.status(429).json({
            error: `Size advice limit reached: ${SIZE_ADVICE_PER_HOUR} per hour. Retry in ${budget.retryAfterSec}s.`,
            retryAfterSec: budget.retryAfterSec
          });
        }
      }

      const result = await recommendSizeFromPhoto(userPhoto);
      return res.json({ success: true, ...result });


    } catch (error) {

      console.error(
        "Size recommendation failed:",
        error
      );


      const status = statusFor(error);
      return res.status(status).json({

        error: status === 400
          ? error.message
          : publicMessage(error, "Size advice is unavailable right now. Please try again shortly.")

      });

    }

  }

);


// ============================================================
// ENDPOINT 1: GENERATE TOP WEAR (MODEL MODE)
// ============================================================
//
// POST /api/v1/draping/generate-top-wear
//
// Uses Supabase body references. No user photo.
// Sizes: S, M, L, XL, XXL, XXXL
// Categories: FORMALS, BLAZER, KURTA_PAJAMA, SHERWANI, etc.
//

router.post(

  "/generate-top-wear",

  async (req, res) => {

    const {
      clientId = "men-frontend",
      full,
      topFront,
      bottom,
      category,
      sizes = []
    } = req.body;


    // Validate garment
    if (!full && !topFront) {
      return res.status(400).json({
        error: "Garment image is required."
      });
    }

    // Validate sizes
    if (!Array.isArray(sizes) || sizes.length === 0) {
      return res.status(400).json({
        error: "sizes array is required and cannot be empty."
      });
    }

    const validatedSizes = sizes.map(s => String(s).toUpperCase().trim());
    const isValid = validatedSizes.every(s => STANDARD_SIZES.includes(s));

    if (!isValid) {
      return res.status(400).json({
        error: "Invalid size. Allowed sizes are S, M, L, XL, XXL and XXXL."
      });
    }


    await runSSEGeneration(req, res, {
      clientId,
      full,
      topFront,
      bottom,
      category,
      categoryGroup: "TOP_WEAR",
      userPhoto: null,
      validatedSizes,
      sizeType: "standard",
      useBodyReferences: true,
      modeName: "TOP WEAR CATALOG"
    });

  }

);


// ============================================================
// ENDPOINT 2: GENERATE BOTTOM WEAR (MODEL MODE)
// ============================================================
//
// POST /api/v1/draping/generate-bottom-wear
//
// Uses Supabase body references (mapped from waist to letter).
// No user photo.
// Sizes: 28, 30, 32, 34, 36, 38, 40
//

router.post(

  "/generate-bottom-wear",

  async (req, res) => {

    const {
      clientId = "men-frontend",
      full,
      topFront,
      bottom,
      tops,
      category,
      sizes = []
    } = req.body;


    // Validate garment
    if (!full && !topFront && !bottom) {
      return res.status(400).json({
        error: "Garment image is required."
      });
    }

    if (tops && !Array.isArray(tops)) {
      return res.status(400).json({
        error: "Tops must be an array."
      });
    }

    // Validate sizes
    if (!Array.isArray(sizes) || sizes.length === 0) {
      return res.status(400).json({
        error: "sizes array is required and cannot be empty."
      });
    }

    const validatedSizes = sizes.map(s => String(s).toUpperCase().trim());
    const isValid = validatedSizes.every(s => WAIST_SIZES.includes(s));

    if (!isValid) {
      return res.status(400).json({
        error: "Invalid waist size. Allowed sizes are 28, 30, 32, 34, 36, 38, 40."
      });
    }


    await runSSEGeneration(req, res, {
      clientId,
      full,
      topFront,
      bottom,
      tops,
      category,
      categoryGroup: "BOTTOM_WEAR",
      userPhoto: null,
      validatedSizes,
      sizeType: "waist",
      useBodyReferences: true,
      modeName: "BOTTOM WEAR CATALOG"
    });

  }

);


// ============================================================
// ENDPOINT 3: GENERATE USER TRY-ON
// ============================================================
//
// POST /api/v1/draping/generate-user-tryon
//
// No Supabase body references. User's body stays locked.
// Requires user photo.
// Accepts both standard and waist sizes.
//

router.post(

  "/generate-user-tryon",

  async (req, res) => {

    const {
      clientId = "men-frontend",
      full,
      topFront,
      bottom,
      tops,
      categoryGroup = "TOP_WEAR",
      category,
      userPhoto,
      sizes = [],
      sizeType = "standard"
    } = req.body;


    // Validate user photo
    if (!userPhoto || userPhoto === 'null' || userPhoto === 'undefined') {
      return res.status(400).json({
        error: "User photo is required for try-on mode."
      });
    }

    // Validate garment
    if (!full && !topFront && !bottom) {
      return res.status(400).json({
        error: "Garment image is required."
      });
    }

    if (categoryGroup === "BOTTOM_WEAR" && tops && !Array.isArray(tops)) {
      return res.status(400).json({
        error: "Tops must be an array."
      });
    }

    // Validate sizes
    if (!Array.isArray(sizes) || sizes.length === 0) {
      return res.status(400).json({
        error: "sizes array is required and cannot be empty."
      });
    }

    const validatedSizes = sizes.map(s => String(s).toUpperCase().trim());

    if (sizeType === "standard") {
      const isValid = validatedSizes.every(s => STANDARD_SIZES.includes(s));
      if (!isValid) {
        return res.status(400).json({
          error: "Invalid size. Allowed sizes are S, M, L, XL, XXL and XXXL."
        });
      }
    } else if (sizeType === "waist") {
      const isValid = validatedSizes.every(s => WAIST_SIZES.includes(s));
      if (!isValid) {
        return res.status(400).json({
          error: "Invalid waist size. Allowed sizes are 28, 30, 32, 34, 36, 38, 40."
        });
      }
    } else {
      return res.status(400).json({
        error: "Invalid sizeType. Must be 'standard' or 'waist'."
      });
    }


    await runSSEGeneration(req, res, {
      clientId,
      full,
      topFront,
      bottom,
      category,
      categoryGroup: String(categoryGroup).toUpperCase(),
      userPhoto,
      validatedSizes,
      sizeType,
      useBodyReferences: false,
      modeName: "USER TRY-ON"
    });

  }

);


// ============================================================
// BACKWARDS-COMPATIBLE: GENERATE CATALOG (routes to above)
// ============================================================
//
// POST /api/v1/draping/generate-catalog
//
// This is the original endpoint that still works.
// It inspects the payload and internally routes to the
// correct generation mode.
//

router.post(

  "/generate-catalog/men",

  async (req, res) => {

    const {
      clientId = "men-frontend",
      full,
      topFront,
      bottom,
      tops,
      categoryGroup = "TOP_WEAR",
      category,
      userPhoto,
      sizes = [],
      sizeType = "standard"
    } = req.body;


    // Validate garment
    if (!full && !topFront && !bottom) {
      return res.status(400).json({
        error: "Garment image is required."
      });
    }

    // Validate sizes
    if (!Array.isArray(sizes) || sizes.length === 0) {
      return res.status(400).json({
        error: "sizes array is required and cannot be empty."
      });
    }

    const validatedSizes = sizes.map(s => String(s).toUpperCase().trim());

    if (sizeType === "standard") {
      const isValid = validatedSizes.every(s => STANDARD_SIZES.includes(s));
      if (!isValid) {
        return res.status(400).json({
          error: "Invalid size. Allowed sizes are S, M, L, XL, XXL and XXXL."
        });
      }
    } else if (sizeType === "waist") {
      const isValid = validatedSizes.every(s => WAIST_SIZES.includes(s));
      if (!isValid) {
        return res.status(400).json({
          error: "Invalid waist size. Allowed sizes are 28, 30, 32, 34, 36, 38, 40."
        });
      }
    } else {
      return res.status(400).json({
        error: "Invalid sizeType."
      });
    }

    // Determine mode
    const isUserPhotoActive = userPhoto && userPhoto !== 'null' && userPhoto !== 'undefined';
    const isTopWear = String(categoryGroup).toUpperCase() === 'TOP_WEAR';

    let modeName;
    if (isUserPhotoActive) {
      modeName = "USER TRY-ON";
    } else if (isTopWear) {
      modeName = "TOP WEAR CATALOG";
    } else {
      modeName = "BOTTOM WEAR CATALOG";
    }

    await runSSEGeneration(req, res, {
      clientId,
      full,
      topFront,
      bottom,
      tops,
      category,
      categoryGroup: String(categoryGroup).toUpperCase(),
      userPhoto: isUserPhotoActive ? userPhoto : null,
      validatedSizes,
      sizeType,
      useBodyReferences: !isUserPhotoActive,
      modeName
    });

  }

);


// ============================================================
// CANCEL JOB
// ============================================================

router.post(

  "/cancel-job/men",

  async (
    req,
    res
  ) => {

    const {

      clientId =
        "men-frontend"

    } = req.body;


    if (await cancelGeneration(req, { clientId, pipeline: "men" })) {

      console.log(
        `Generation cancelled for ${clientId}`
      );


      return res.json({

        success:
          true,

        message:
          "Generation cancelled."

      });

    }


    return res.json({

      success:
        true,

      message:
        "No active generation found."

    });

  }

);


// ============================================================
// EXPORT
// ============================================================

module.exports =
  router;
