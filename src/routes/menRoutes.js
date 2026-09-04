const express = require("express");

const router = express.Router();

// A bad user photo is the caller's problem (400) and an upstream refusal is a
// dependency problem (424). Neither is a 5xx: the gateway's circuit breaker
// counts 5xx per slug, so returning 500 here could take the whole service
// offline for everyone including the women pipeline and discovery.
function statusFor(error) {
  const msg = (error && error.message) || '';
  if (/user photo is required|unable to read/i.test(msg)) return 400;
  if (/gemini|http 4\d\d|http 5\d\d/i.test(msg)) return 424;
  return 500;
}




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

const INTERNAL_API_KEY =
  process.env.INTERNAL_API_KEY ||
  "se_catalog_internal_key_v1_99283";


// ============================================================
// SIMPLE JOB STORE
// ============================================================

const activeJobs =
  new Map();


let previousJobs =
  0;


// ============================================================
// API KEY MIDDLEWARE
// ============================================================

const verifyApiKey = (
  req,
  res,
  next
) => {

  const apiKey =
    req.headers["x-api-key"];


  if (
    !apiKey ||
    apiKey !== INTERNAL_API_KEY
  ) {

    return res.status(401).json({

      error:
        "Unauthorized request."

    });

  }


  next();

};


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
  // CANCEL PREVIOUS JOB FOR SAME CLIENT
  // --------------------------------------------------------

  const existingJob = activeJobs.get(clientId);

  if (existingJob) {
    console.log(`Cancelling previous job for ${clientId}`);
    existingJob.abort();
    activeJobs.delete(clientId);
  }


  // --------------------------------------------------------
  // CREATE JOB
  // --------------------------------------------------------

  const controller = new AbortController();
  activeJobs.set(clientId, controller);
  previousJobs += 1;


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
    res.write(`data: ${JSON.stringify(data)}\n\n`);
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

    const isMixAndMatch = categoryGroup === 'BOTTOM_WEAR' && Array.isArray(tops) && tops.length > 0;
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

            sendEvent({
              type: "SIZE_READY",
              size: currentSize,
              topIndex: isMixAndMatch ? topIndex : undefined,
              result: result
            });
          } catch (error) {
            console.error(`Error generating size ${currentSize}:`, error);
            sendEvent({
              type: "ERROR",
              error: error.message || String(error)
            });
          }
        })());
      }
    }

    await Promise.allSettled(generationJobs);

    sendEvent({
      type: "COMPLETE",
      results: allResults,
      mode: userPhoto ? "USER_PHOTO" : "MODEL"
    });

    console.log(`MEN'S ${modeName} GENERATION COMPLETE`);

  } catch (error) {

    console.error(`MEN'S ${modeName} GENERATION ERROR:`, error);

    if (error.name === "AbortError") {
      sendEvent({
        type: "ERROR",
        error: "Generation cancelled."
      });
    } else {
      sendEvent({
        type: "ERROR",
        error: error.message || "Generation failed."
      });
    }

  } finally {
    activeJobs.delete(clientId);
    res.end();
  }
}


// ============================================================
// ANALYZE USER PHOTO AND RECOMMEND SIZE
// ============================================================

router.post(

  "/recommend-size",

  verifyApiKey,

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


      const result = await recommendSizeFromPhoto(userPhoto);
      return res.json({ success: true, ...result });


    } catch (error) {

      console.error(
        "Size recommendation failed:",
        error
      );


      return res.status(statusFor(error)).json({

        error:
          error.message ||
          "Failed to recommend size."

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

  verifyApiKey,

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

  verifyApiKey,

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

  verifyApiKey,

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

  verifyApiKey,

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

  verifyApiKey,

  (
    req,
    res
  ) => {

    const {

      clientId =
        "men-frontend"

    } = req.body;


    const job =
      activeJobs.get(
        clientId
      );


    if (job) {

      job.abort();


      activeJobs.delete(
        clientId
      );


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
