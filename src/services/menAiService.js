const { getDynamicPrompt } = require('../config/sys-constants-men');
const { ENVIRONMENTS } = require('../config/environments-men');
const sharp = require('sharp');

const FALLBACK_FRONT_MODEL_URL =
  'https://slvakgspnsyvpuakfmvb.supabase.co/storage/v1/object/public/men%20models/men%20models/formals/model%201.png';


// ============================================================
// DOWNLOAD IMAGE URL → BASE64
// ============================================================

async function imageUrlToBase64(imageUrl) {

  const response =
    await fetch(imageUrl);

  if (!response.ok) {

    throw new Error(
      `Image download failed: HTTP ${response.status}`
    );

  }

  const arrayBuffer =
    await response.arrayBuffer();

  const buffer =
    Buffer.from(arrayBuffer);

  return buffer.toString('base64');

}


// ============================================================
// CLEAN BASE64
// ============================================================

function cleanBase64(b64) {

  if (!b64) {
    return null;
  }

  if (
    b64.startsWith('data:image')
  ) {

    return b64.split(',')[1];

  }

  return b64;

}


// ============================================================
// GET MIME TYPE FROM DATA URL
// ============================================================

function getMimeType(value) {

  if (
    typeof value === 'string' &&
    value.startsWith('data:')
  ) {

    const match =
      value.match(
        /^data:(image\/[^;]+);base64,/
      );

    if (match) {
      return match[1];
    }

  }

  return 'image/png';

}


// ============================================================
// IMAGE INPUT → BASE64
//
// Supports:
// 1. Supabase/public image URL
// 2. Data URL
// 3. Raw base64
// ============================================================

async function imageInputToBase64(imageInput) {

  if (!imageInput) {
    return null;
  }


  // ----------------------------------------------------------
  // URL
  // ----------------------------------------------------------

  if (
    typeof imageInput === 'string' &&
    (
      imageInput.startsWith('http://') ||
      imageInput.startsWith('https://')
    )
  ) {

    return await imageUrlToBase64(
      imageInput
    );

  }


  // ----------------------------------------------------------
  // BASE64 / DATA URL
  // ----------------------------------------------------------

  return cleanBase64(
    imageInput
  );

}


// ============================================================
// AUGMENTED RESIZE
// ============================================================

async function augmentedResize(base64Str) {

  if (!base64Str) {
    return null;
  }

  const cleaned =
    cleanBase64(base64Str);

  const inputBuffer =
    Buffer.from(
      cleaned,
      'base64'
    );


  const meta =
    await sharp(
      inputBuffer
    ).metadata();


  const cropPx =
    Math.max(
      1,
      Math.floor(
        Math.min(
          meta.width || 512,
          meta.height || 512
        ) * 0.01
      )
    );


  const outputBuffer =
    await sharp(inputBuffer)

      .extract({

        left:
          cropPx,

        top:
          cropPx,

        width:
          (meta.width || 512) -
          cropPx * 2,

        height:
          (meta.height || 512) -
          cropPx * 2

      })

      .resize(
        1024,
        1024,
        {

          fit:
            'inside',

          withoutEnlargement:
            true

        }
      )

      .modulate({

        brightness:
          1.02,

        saturation:
          0.98

      })

      .png()

      .toBuffer();


  return outputBuffer.toString(
    'base64'
  );

}


// ============================================================
// GEMINI IMAGE GENERATION
// ============================================================

async function callGeminiImageGen(
  partsArray,
  abortSignal
) {

  const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY;


  if (!GEMINI_API_KEY) {

    throw new Error(
      'GEMINI_API_KEY not set in .env'
    );

  }


  const GEMINI_URL =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent';


  const payload = {

    contents: [

      {

        parts:
          partsArray

      }

    ],

    generationConfig: {

      temperature:
        0.1

    }

  };


  let resp;

  let retries = 3;

  let delay = 2000;


  while (retries > 0) {

    try {

      resp =
        await fetch(
          GEMINI_URL,
          {

            method:
              'POST',

            headers: {

              'Content-Type':
                'application/json',

              'x-goog-api-key':
                GEMINI_API_KEY

            },

            body:
              JSON.stringify(
                payload
              ),

            signal:
              abortSignal

          }
        );


      // ------------------------------------------------------
      // RETRY 503 / 429
      // ------------------------------------------------------

      if (
        resp.status === 503 ||
        resp.status === 429
      ) {

        const errText =
          await resp.text();

        console.warn(
          `[Gemini API] HTTP ${resp.status}. Retries left: ${
            retries - 1
          }`
        );

        retries--;

        if (retries === 0) {

          throw new Error(
            `Gemini API Error: HTTP ${resp.status} - ${errText}`
          );

        }


        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              delay
            )
        );

        delay *= 2;

        continue;

      }


      // ------------------------------------------------------
      // OTHER API ERRORS
      // ------------------------------------------------------

      if (!resp.ok) {

        const errText =
          await resp.text();

        throw new Error(
          `Gemini API Error: HTTP ${resp.status} - ${errText}`
        );

      }


      break;


    } catch (err) {

      if (
        err.name === 'AbortError' ||
        err.message?.includes(
          'AbortError'
        )
      ) {

        throw err;

      }


      if (
        retries === 1 ||
        err.message?.includes(
          'HTTP 400'
        )
      ) {

        throw err;

      }


      console.warn(
        `[Gemini API] Request failed: ${err.message}. Retries left: ${
          retries - 1
        }`
      );


      retries--;


      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            delay
          )
      );


      delay *= 2;

    }

  }


  // ==========================================================
  // READ GEMINI RESPONSE
  // ==========================================================

  const respJson =
    await resp.json();


  const candidates =
    respJson.candidates;


  if (
    !candidates ||
    candidates.length === 0
  ) {

    throw new Error(
      'Gemini API returned no candidates.'
    );

  }


  const partsOut =
    candidates[0]?.content?.parts ||
    [];


  let extractedBase64 =
    null;


  let extractedMime =
    'image/jpeg';


  // ----------------------------------------------------------
  // NORMAL IMAGE RESPONSE
  // ----------------------------------------------------------

  for (
    const p of partsOut
  ) {

    const inlineObj =
      p.inline_data ||
      p.inlineData;


    if (
      inlineObj &&
      inlineObj.data
    ) {

      extractedBase64 =
        inlineObj.data;

      extractedMime =
        inlineObj.mime_type ||
        inlineObj.mimeType ||
        'image/jpeg';

      break;

    }

  }


  // ----------------------------------------------------------
  // REGEX FALLBACK
  // ----------------------------------------------------------

  if (!extractedBase64) {

    const rawStr =
      JSON.stringify(
        partsOut
      );


    const dataMatch =
      rawStr.match(
        /"data"\s*:\s*"([^"]+)"/
      );


    const mimeMatch =
      rawStr.match(
        /"mimeType"\s*:\s*"([^"]+)"/
      );


    const altMimeMatch =
      rawStr.match(
        /"mime_type"\s*:\s*"([^"]+)"/
      );


    if (
      dataMatch &&
      dataMatch[1]
    ) {

      extractedBase64 =
        dataMatch[1];


      if (
        mimeMatch &&
        mimeMatch[1]
      ) {

        extractedMime =
          mimeMatch[1];

      } else if (
        altMimeMatch &&
        altMimeMatch[1]
      ) {

        extractedMime =
          altMimeMatch[1];

      }

    }

  }


  // ----------------------------------------------------------
  // RETURN IMAGE
  // ----------------------------------------------------------

  if (extractedBase64) {

    return `data:${extractedMime};base64,${extractedBase64}`;

  }


  // ----------------------------------------------------------
  // GEMINI RETURNED TEXT
  // ----------------------------------------------------------

  const textPart =
    partsOut.find(
      p => p.text
    );


  const textReturned =
    textPart
      ? textPart.text
      : JSON.stringify(
          partsOut
        );


  console.error(
    'GEMINI API RETURNED TEXT INSTEAD OF IMAGE:'
  );

  console.error(
    textReturned
  );


  throw new Error(
    `Gemini API returned text but no image data. Reason: ${textReturned.substring(
      0,
      100
    )}...`
  );

}


function normalizeTryOnInputs(inputs = {}) {
  return {
    fullDress: inputs.fullDress || null,
    topFront: inputs.topFront || null,
    bottom: inputs.bottom || null,
    category: String(inputs.category || 'FORMALS').toUpperCase(),
    categoryGroup: String(inputs.categoryGroup || 'TOP_WEAR').toUpperCase(),
    userPhoto: inputs.userPhoto || null,
    size: String(inputs.size || 'M').toUpperCase().trim(),
    sizeType: inputs.sizeType || 'standard',
    bodyReferenceUrl: inputs.bodyReferenceUrl || null
  };
}

function selectEnvironment() {
  return ENVIRONMENTS[
    Math.floor(Math.random() * ENVIRONMENTS.length)
  ];
}

async function prepareReferenceImages(inputs, isUserPhotoMode) {
  const references = {
    fullDress: await augmentedResize(await imageInputToBase64(inputs.fullDress)),
    topFront: await augmentedResize(await imageInputToBase64(inputs.topFront)),
    bottom: await augmentedResize(await imageInputToBase64(inputs.bottom)),
    userPhoto: null
  };

  if (isUserPhotoMode) {
    references.userPhoto = await augmentedResize(
      await imageInputToBase64(inputs.userPhoto)
    );

    if (!references.userPhoto) {
      throw new Error('Unable to process uploaded user photo.');
    }
  }

  return references;
}

async function resolveBaseModelReference(baseModel, category) {
  const baseModelUrl =
    category === 'KURTA_PAJAMA'
      ? FALLBACK_FRONT_MODEL_URL
      : baseModel?.front || FALLBACK_FRONT_MODEL_URL;

  return augmentedResize(
    await imageUrlToBase64(baseModelUrl)
  );
}

// ============================================================
// BODY MEASUREMENT CONFIGURATIONS
// ============================================================

const TOP_WEAR_MEASUREMENTS = {
  "S": { chest: 36, waist: 30, shoulder: 17, bicep: 12 },
  "M": { chest: 38, waist: 32, shoulder: 17.5, bicep: 12.5 },
  "L": { chest: 40, waist: 34, shoulder: 18, bicep: 13 },
  "XL": { chest: 42, waist: 36, shoulder: 18.5, bicep: 13.5 },
  "XXL": { chest: 44, waist: 38, shoulder: 19, bicep: 14 },
  "XXXL": { chest: 46, waist: 40, shoulder: 19.5, bicep: 14.5 }
};

const BOTTOM_WEAR_MEASUREMENTS = {
  "28": { waist: 28, hip: 34, thigh: 20 },
  "30": { waist: 30, hip: 36, thigh: 21 },
  "32": { waist: 32, hip: 38, thigh: 22 },
  "34": { waist: 34, hip: 40, thigh: 23 },
  "36": { waist: 36, hip: 42, thigh: 24 },
  "38": { waist: 38, hip: 44, thigh: 25 },
  "40": { waist: 40, hip: 46, thigh: 26 }
};

// ============================================================
// MEN'S FRONT-ONLY GENERATION
// ============================================================

async function generateFrontCatalog(
  inputs,
  baseModel,
  onProgress,
  abortSignal
) {

  try {

    const {
      fullDress,
      topFront,
      bottom,
      categoryGroup,
      category,
      userPhoto,
      size: selectedSize,
      sizeType,
      bodyReferenceUrl
    } = normalizeTryOnInputs(inputs);


    // --------------------------------------------------------
    // NORMALIZE SIZE
    // --------------------------------------------------------

    // --------------------------------------------------------
    // DYNAMIC AI PROMPT INSTRUCTIONS
    // --------------------------------------------------------

    let selectedFitInstruction;

    // --------------------------------------------------------
    // BOTTOM WEAR: choose matching outfit (top + footwear) based on category
    // --------------------------------------------------------
    const BOTTOM_CATEGORY_OUTFIT = {
      'TROUSERS':           { top: 'a solid white formal dress shirt with collar, neatly tucked in and properly buttoned', shoes: 'black polished formal leather dress shoes' },
      'STRAIGHT_FIT_PANTS': { top: 'a solid white formal dress shirt with collar, neatly tucked in and properly buttoned', shoes: 'black polished formal leather dress shoes' },
      'TAPERED_FIT_PANTS':  { top: 'a solid white formal dress shirt with collar, neatly tucked in and properly buttoned', shoes: 'black polished formal leather dress shoes' },
      'PANTS':              { top: 'a solid white formal dress shirt with collar, neatly tucked in and properly buttoned', shoes: 'black polished formal leather dress shoes' },
      'JEANS':              { top: 'a plain solid-color casual crew-neck t-shirt', shoes: 'white casual sneakers' },
      'TRACKS':             { top: 'a black sporty zip-up athletic track jacket with collar', shoes: 'sporty athletic running sneakers' },
      'SHORTS':             { top: 'a plain solid-color casual round-neck t-shirt', shoes: 'white casual sneakers' }
    };

    const DEFAULT_OUTFIT = { top: 'a casual solid-color t-shirt', shoes: 'casual sneakers' };

    if (categoryGroup === 'BOTTOM_WEAR') {
      const outfit = BOTTOM_CATEGORY_OUTFIT[category] || DEFAULT_OUTFIT;

      const msmt = BOTTOM_WEAR_MEASUREMENTS[String(selectedSize)] || { waist: selectedSize, hip: parseInt(selectedSize)+6, thigh: 22 };
      const targetMeasurementsText = `Waist: ${msmt.waist} inches
Hip: ${msmt.hip} inches
Thigh circumference: ${msmt.thigh} inches`;

      const isMixAndMatch = !!topFront;
      const topWearRule = isMixAndMatch 
        ? `- The model MUST wear EXACTLY the top garment provided in the TOP GARMENT REFERENCE.
- Only change/apply this top garment.
- Do not replace, redesign, recolor, alter, or invent the bottom garment.
- The bottom garment must remain visually consistent with the original reference.`
        : `- The model MUST wear EXACTLY: ${outfit.top}
- The model must NEVER appear shirtless or bare-chested.
- This EXACT SAME top (same style, same color, same design) must appear on EVERY size. No variation allowed.`;

      const footwearRule = isMixAndMatch
        ? `- Keep the footwear consistent with the bottom garment.`
        : `- The model MUST wear EXACTLY: ${outfit.shoes}
- This EXACT SAME footwear (same style, same color) must appear on EVERY size. No variation allowed.`;

      const consistencyRule = isMixAndMatch
        ? `- The bottom wear and overall styling must be IDENTICAL across ALL sizes. Do not change the bottom garment.`
        : `- The top wear, footwear, and overall styling must be IDENTICAL across ALL sizes.
- Do NOT change the top garment style, color, or type between sizes.
- Do NOT change the shoe style, color, or type between sizes.`;

      selectedFitInstruction = `
Generate the SAME PERSON from the reference image.

Preserve the exact person's:
- Face
- Facial identity
- Facial features
- Hairstyle
- Skin tone
- Identity
- Pose
- Camera angle
- Camera distance
- Image framing
- Background
- Lighting

The selected clothing size is ${selectedSize}.

Target body measurements:
${targetMeasurementsText}

Transform the person's ACTUAL BODY PROPORTIONS to realistically correspond to these target measurements.

The body itself must become physically broader/fuller according to these measurements for larger sizes, and leaner/narrower for smaller sizes.

CRITICAL: Do not zoom the person. Do not crop the image. Do not enlarge the image. Do not scale the person in the frame. Do not change camera distance. Do not change framing. Do not enlarge the head.

The size difference must come entirely from the person's actual physical body proportions, NOT from camera manipulation.

Preserve the same person's identity.

The garment should fit naturally on the transformed body.

COMPLETE OUTFIT RULES (CRITICAL — BOTTOM WEAR MODE):

TOP WEAR:
${topWearRule}

FOOTWEAR:
${footwearRule}

CONSISTENCY RULE:
${consistencyRule}
`;
    } else {
      if (bodyReferenceUrl) {
        selectedFitInstruction = `
PRIMARY BODY REFERENCE:
The supplied size-specific body reference image determines the person's actual body proportions, width, chest, shoulders, waist, abdomen, arms and overall body volume.
CRITICAL: You MUST extract the EXACT background (color, walls, floor, environment) from this size-specific body reference image.
CRITICAL CLOTHING OVERRIDE: YOU MUST COMPLETELY ERASE AND REPLACE whatever the person is wearing in this body reference image! Do NOT keep their shirt. Do NOT keep their pants. Overwrite their entire outfit.

GARMENT REFERENCE:
The supplied garment image determines the exact garment design, color, fabric, pattern and construction.
CRITICAL: You MUST dress the person ONLY in this exact garment. If the uploaded garment is a short shirt, draw a short shirt. Do NOT draw a long kurta unless the uploaded garment is a kurta.
CRITICAL NEGATIVE: Do NOT copy the background from the garment image. Ignore any trees, outdoors, or scenes in the garment image.

PERSON IDENTITY:
Preserve the established male model's facial identity/style where applicable, but do NOT preserve the old body's proportions when a size-specific body reference is supplied.
`;
      } else {
        let bodyShapeInstruction = "";
        switch(String(selectedSize).toUpperCase()) {
          case "S":
            bodyShapeInstruction = `Create a clearly lean/slim male body:
- narrow shoulders
- slim chest
- narrow torso
- narrow waist
- slim arms
- slim overall upper body`;
            break;
          case "M":
            bodyShapeInstruction = `Create a slightly fuller body than S:
- slightly wider shoulders
- slightly fuller chest
- slightly wider torso
- slightly fuller arms
- slightly wider waist`;
            break;
          case "L":
            bodyShapeInstruction = `Create a visibly fuller body than M:
- broader shoulders
- broader chest
- wider torso
- wider waist
- thicker arms`;
            break;
          case "XL":
            bodyShapeInstruction = `Create a clearly broad/full body:
- noticeably broader shoulders
- fuller chest
- wider abdomen
- wider waist
- thicker arms
- increased overall upper-body volume`;
            break;
          case "XXL":
            bodyShapeInstruction = `Create a substantially fuller/heavier body:
- significantly broader shoulders
- significantly fuller chest
- wider torso
- visibly wider abdomen
- wider waist
- noticeably thicker arms
- increased overall body mass`;
            break;
          case "XXXL":
            bodyShapeInstruction = `Create a clearly LARGE/FULL male body.
The XXXL model must be visibly and substantially heavier/fuller than the S model.
Increase the actual body volume and width of:
- shoulders
- chest
- upper torso
- abdomen
- waist
- arms
The abdomen and waist must visibly become wider.
The chest must visibly become fuller.
The shoulders must become broader.
The arms must become thicker.
Do NOT achieve this by zooming or scaling the image.
The person's body must physically occupy more WIDTH inside the same camera frame.`;
            break;
          default:
            bodyShapeInstruction = "Create a male body matching size " + selectedSize + ".";
            break;
        }

        selectedFitInstruction = `
1. IDENTITY PRESERVATION
Keep the exact same person, face, facial features, hairstyle, skin tone and identity.

2. BODY TRANSFORMATION
Transform the actual body proportions according to the selected size and body profile. The physical width and volume of the shoulders, chest, torso, waist and arms must change.

${bodyShapeInstruction}

3. GARMENT FIT
Apply the selected garment size (${selectedSize}) while preserving the existing garment design and appearance.

CRITICAL NEGATIVE CONSTRAINTS:
- Do not keep the original body proportions.
- Do not simply enlarge or shrink the garment.
- Do not zoom the image.
- Do not change camera distance.
- Do not crop differently.
- Do not enlarge the head.
- Do not change the face.
- Do not replace the person.
- Do not create only a looser garment.
The physical body proportions must change.
`;
      }
    }



    // --------------------------------------------------------
    // USER PHOTO MODE
    // --------------------------------------------------------

    const isUserPhotoMode =
      Boolean(userPhoto && userPhoto !== 'null' && userPhoto !== 'undefined');


    console.log(
      '========================================'
    );

    console.log(
      "Starting Men's Front-Only Generation"
    );

    const isBottomWear = categoryGroup === 'BOTTOM_WEAR';
    const bodyPartsText = isBottomWear 
      ? 'lower body (hips, thighs, legs)'
      : 'upper body (chest, shoulders, torso, arms, waist)';
    const bodyRegionText = isBottomWear 
      ? 'lower body' 
      : 'upper body';

    console.log(
      'Category:',
      category
    );

    console.log(
      'Selected Size:',
      selectedSize,
      '| Type:',
      sizeType
    );

    console.log(
      'Mode:',
      isUserPhotoMode
        ? 'USER PHOTO TRY-ON'
        : 'MEN MODEL CATALOG'
    );

    console.log(
      'User Photo:',
      isUserPhotoMode
        ? 'Provided'
        : 'Not provided'
    );

    console.log(
      '========================================'
    );


    // --------------------------------------------------------
    // SELECT BACKGROUND ENVIRONMENT
    // --------------------------------------------------------

    let randomEnv = selectEnvironment();
    if (bodyReferenceUrl) {
      randomEnv = `CRITICAL BACKGROUND RULE:
PRESERVE THE EXACT SAME BACKGROUND COLOR, WALL, FLOOR AND ENVIRONMENT FROM THE SUPPLIED SIZE-SPECIFIC BODY REFERENCE IMAGE.

DO NOT CHANGE THE BACKGROUND.

Do not add trees, plants, outdoors, furniture, people, decorations, text, logos or objects.

Only maintain the exact same clean professional lighting from the body reference image. Ignore the background of the garment image completely.`;
    }

    console.log(
      'Selected Environment:',
      randomEnv
    );


    // --------------------------------------------------------
    // CHECK CANCELLATION
    // --------------------------------------------------------

    if (
      abortSignal?.aborted
    ) {

      throw new Error(
        'AbortError: Generation cancelled by client'
      );

    }


    // --------------------------------------------------------
    // PROCESS GARMENT
    // --------------------------------------------------------

    console.log(
      'Processing garment image...'
    );


    const preparedReferences =
      await prepareReferenceImages(
        { fullDress, topFront, bottom, userPhoto },
        isUserPhotoMode
      );

    const processedFullDress = preparedReferences.fullDress;
    const processedTopFront = preparedReferences.topFront;
    const processedBottom = preparedReferences.bottom;
    const processedUserPhoto = preparedReferences.userPhoto;


    // --------------------------------------------------------
    // INPUT SLOTS
    // --------------------------------------------------------

    const inputSlots = {

      hasFullDress:
        !!fullDress,

      hasTop:
        !!topFront,

      hasBottom:
        !!bottom,

      hasReference:
        isUserPhotoMode

    };


    // --------------------------------------------------------
    // BUILD GEMINI PAYLOAD
    // --------------------------------------------------------

    const parts = [];


    // ========================================================
    // USER PHOTO MODE
    // ========================================================

    if (isUserPhotoMode) {
      
      const s = String(selectedSize).toUpperCase();
      const map = { '28': 'S', '30': 'S', '32': 'M', '34': 'L', '36': 'XL', '38': 'XXL', '40': 'XXXL' };
      const mappedSize = map[s] || s;
      
      let loosenessInstruction = "";
      switch(mappedSize) {
        case "S": loosenessInstruction = "The garment must be drawn TIGHT and FORM-FITTING on the user's body."; break;
        case "M": loosenessInstruction = "The garment must have a SLIM, TAILORED FIT on the user's body."; break;
        case "L": loosenessInstruction = "The garment must have a REGULAR, COMFORTABLE FIT on the user's body."; break;
        case "XL": loosenessInstruction = "The garment must be LOOSE and SLIGHTLY BAGGY on the user's body, with visible extra room."; break;
        case "XXL": loosenessInstruction = "The garment must be OVERSIZED and NOTICEABLY BAGGY on the user's body, with extra fabric bunching and draping loosely."; break;
        case "XXXL": loosenessInstruction = "The garment must be EXTREMELY OVERSIZED, EXCESSIVELY BAGGY and VERY LOOSE on the user's body, drowning the user in excess fabric that folds and drapes heavily."; break;
        default: loosenessInstruction = "The physical size and looseness of the garment should match size " + selectedSize + "."; break;
      }

      const userPhotoPrompt = `
MEN'S VIRTUAL TRY-ON — USER PHOTO MODE.

Use the provided USER PHOTO as the exact person reference.

Use the provided GARMENT REFERENCE as the exact clothing
that the person must wear.

The final image must show the SAME PERSON from the uploaded
user photo wearing the provided garment.

IDENTITY LOCK (IMPORTANT):
- Preserve the exact identity of the reference person.
- Keep the same face, facial features, hairstyle, skin tone, pose, camera angle, background, lighting, shirt, shoes and accessories.
- Do not replace the person with another model.
- Do not create a different face.

BODY LOCK (CRITICAL):
- Do NOT change the physical body proportions of the user.
- The user's body size must remain exactly the same as in their uploaded photo.
- ONLY the garment size/fit should change (e.g., looser for larger sizes, tighter for smaller sizes).

GARMENT LOCK:
- Preserve the exact uploaded garment as the same garment.
- Do not recolor, redesign, replace or reinterpret the garment.
- Maintain realistic fabric texture, folds, shadows and draping.

SIZE AND FIT INSTRUCTION:
- Generate the garment in size ${selectedSize}.
- CRITICAL FIT RULE: ${loosenessInstruction}
- However, the PERSON'S body must remain exactly the same as in the original photo.
- Do NOT distort the person's body to make the garment fit.

The final output should look like a realistic photograph of
the uploaded person trying on this exact garment in size
${selectedSize}, with the garment correctly fitted to their original body.

Background:
${randomEnv}

Generate ONE final FRONT VIEW image.

Do not return text.
`;


      parts.push({
        text: userPhotoPrompt
      });

      // Push user photo IMMEDIATELY after the prompt so the AI anchors on identity
      parts.push({
        text: `USER PHOTO — THIS IS THE EXACT PERSON. You MUST preserve this exact face, hair, skin tone, body, pose, and background. Do NOT generate a different person. Do NOT change their appearance in any way.`
      });

      parts.push({
        inline_data: {
          mime_type: getMimeType(userPhoto),
          data: cleanBase64(processedUserPhoto)
        }
      });


    } else {

      // ======================================================
      // EXISTING MEN'S MODEL MODE
      // ======================================================

      const prompt =
        getDynamicPrompt(
          'FRONT',
          category,
          inputSlots,
          randomEnv
        );


      const sizePrompt = `

SELECTED GARMENT SIZE: ${selectedSize}.

${selectedFitInstruction}

IMPORTANT BODY TRANSFORMATION:
Adjust the HUMAN MODEL'S BODY PROPORTIONS to realistically correspond to this size (${selectedSize}).
The body itself must visibly change according to the selected size.
For smaller sizes, create a visibly leaner and narrower ${bodyRegionText}.
For larger sizes, create a visibly broader and fuller ${bodyRegionText}.
Do NOT keep the male model's body exactly the same across sizes.
The size difference must be clearly visible in the person's body (${bodyPartsText}).
Preserve the exact identity of the reference person (face, hairstyle, skin tone).
`;


      parts.push({

        text:
          `${prompt}\n${sizePrompt}`

      });

    }


    // ========================================================
    // PRIMARY GARMENT
    // ========================================================

    if (
      processedFullDress
    ) {

      parts.push({

        text:
          isUserPhotoMode
            ? `GARMENT REFERENCE — The exact Men's garment the uploaded person must wear in selected size ${selectedSize}.`
            : `GARMENT REFERENCE — The exact garment the male model must wear with selected size ${selectedSize} fit.`

      });


      parts.push({

        inline_data: {

          mime_type:
            getMimeType(fullDress),

          data:
            cleanBase64(
              processedFullDress
            )

        }

      });

    }


    // ========================================================
    // TOP REFERENCE
    // ========================================================

    if (
      processedTopFront
    ) {

      parts.push({

        text:
          `TOP GARMENT REFERENCE — Reproduce this exact top garment with ${selectedSize} size fit:`

      });


      parts.push({

        inline_data: {

          mime_type:
            getMimeType(topFront),

          data:
            cleanBase64(
              processedTopFront
            )

        }

      });

    }


    // ========================================================
    // BOTTOM REFERENCE
    // ========================================================

    if (
      processedBottom
    ) {

      parts.push({

        text:
          `BOTTOM GARMENT REFERENCE — Reproduce this exact bottom garment with ${selectedSize} size fit:`

      });


      parts.push({

        inline_data: {

          mime_type:
            getMimeType(bottom),

          data:
            cleanBase64(
              processedBottom
            )

        }

      });

    }


    // ========================================================
    // PERSON REFERENCE
    // ========================================================

    if (isUserPhotoMode) {

      // Final identity anchor — push user photo again at the end as a reminder
      parts.push({
        text: `FINAL IDENTITY REMINDER — This is the same user photo shown earlier. The generated image MUST show this EXACT same person with the EXACT same face, hair, skin tone, body shape, pose, and background. ONLY the garment should be different.`
      });

      parts.push({
        inline_data: {
          mime_type: getMimeType(userPhoto),
          data: cleanBase64(processedUserPhoto)
        }
      });


    } else {

      console.log(
        "Downloading Men's Base Model..."
      );


      if (bodyReferenceUrl && isBottomWear) {
        // Bottom wear: use ONLY the body reference image as the model
        // Do NOT use men models from Supabase
        const bodyRefImage = await augmentedResize(await imageUrlToBase64(bodyReferenceUrl));

        const outfitRef = {
          'TROUSERS':           { top: 'a solid white formal dress shirt with collar, neatly tucked in and properly buttoned', shoes: 'black polished formal leather dress shoes' },
          'STRAIGHT_FIT_PANTS': { top: 'a solid white formal dress shirt with collar, neatly tucked in and properly buttoned', shoes: 'black polished formal leather dress shoes' },
          'TAPERED_FIT_PANTS':  { top: 'a solid white formal dress shirt with collar, neatly tucked in and properly buttoned', shoes: 'black polished formal leather dress shoes' },
          'PANTS':              { top: 'a solid white formal dress shirt with collar, neatly tucked in and properly buttoned', shoes: 'black polished formal leather dress shoes' },
          'JEANS':              { top: 'a plain solid-color casual crew-neck t-shirt', shoes: 'white casual sneakers' },
          'TRACKS':             { top: 'a black sporty zip-up athletic track jacket with collar', shoes: 'sporty athletic running sneakers' },
          'SHORTS':             { top: 'a plain solid-color casual round-neck t-shirt', shoes: 'white casual sneakers' }
        }[category] || { top: 'a casual solid-color t-shirt', shoes: 'casual sneakers' };

        const mixAndMatchText = topFront 
          ? `COMPLETE OUTFIT RULES: TOP — The model MUST wear EXACTLY the top garment provided in the TOP GARMENT REFERENCE. Do not replace, redesign, recolor, alter, or invent the bottom garment. It must remain visually consistent with the original reference.`
          : `COMPLETE OUTFIT RULES: TOP — The model MUST wear EXACTLY: ${outfitRef.top}. FOOTWEAR — The model MUST wear EXACTLY: ${outfitRef.shoes}. The model must NEVER appear shirtless. The EXACT SAME top wear (same style, same color) and EXACT SAME footwear (same style, same color) must appear on EVERY size with zero variation.`;

        parts.push({
          text: `BODY MODEL REFERENCE — This is the EXACT person/model to use. Preserve this exact person's face, identity, hairstyle, skin tone, pose, camera angle, background, and lighting. Use this exact body as the primary reference for the person's physical proportions. CRITICAL CLOTHING OVERRIDE: Replace the person's BOTTOM WEAR with the garment from the garment reference. ${mixAndMatchText}`
        });

        parts.push({
          inline_data: { mime_type: 'image/png', data: cleanBase64(bodyRefImage) }
        });
      } else if (bodyReferenceUrl) {
        // Top wear: use both base model (for identity) and body reference (for proportions)
        const resolvedBaseModel = await resolveBaseModelReference(baseModel, category);
        const bodyRefImage = await augmentedResize(await imageUrlToBase64(bodyReferenceUrl));
        
        parts.push({
          text: `IDENTITY REFERENCE — Preserve this exact male model's face, identity, hairstyle, skin tone and appearance. Do not replace his face.`
        });
        
        parts.push({
          inline_data: { mime_type: 'image/png', data: cleanBase64(resolvedBaseModel) }
        });
        
        parts.push({
          text: `SIZE-SPECIFIC BODY REFERENCE — Use this exact body as the primary reference for the person's physical proportions. Do not replace the model. Apply the garment to this exact body naturally. CRITICAL CLOTHING OVERRIDE: YOU MUST COMPLETELY ERASE AND REPLACE whatever the person is wearing in this body reference image! Do NOT keep their shirt, pants, or outfit. You must dress them ONLY in the garment provided in the garment reference.`
        });
        
        parts.push({
          inline_data: { mime_type: 'image/png', data: cleanBase64(bodyRefImage) }
        });
      } else {
        const resolvedBaseModel = await resolveBaseModelReference(baseModel, category);
        parts.push({
          text: `BASE MODEL — Dress this exact male model. Preserve his exact face, identity, hairstyle, skin tone and appearance. Do not replace the model. Apply the garment using selected size ${selectedSize} and adjust the model's body proportions to realistically correspond to this size.`
        });

        parts.push({
          inline_data: {
            mime_type: 'image/png',
            data: cleanBase64(resolvedBaseModel)
          }
        });
      }

    }


    // --------------------------------------------------------
    // FINAL CANCELLATION CHECK
    // --------------------------------------------------------

    if (
      abortSignal?.aborted
    ) {

      throw new Error(
        'AbortError: Generation cancelled by client'
      );

    }


    // --------------------------------------------------------
    // CALL GEMINI — ONLY ONCE
    // --------------------------------------------------------

    console.log(
      isUserPhotoMode
        ? `Generating User Photo Try-On in ${selectedSize} size with Gemini...`
        : `Generating ONE Front View in ${selectedSize} size with Gemini...`
    );


    const generatedFront =
      await callGeminiImageGen(
        parts,
        abortSignal
      );


    console.log(
      isUserPhotoMode
        ? `Men's User Photo Try-On (${selectedSize}) generated successfully.`
        : `Men's Front View (${selectedSize}) generated successfully.`
    );


    // --------------------------------------------------------
    // SEND PROGRESS
    // --------------------------------------------------------

    if (onProgress) {

      onProgress({

        view:
          'front',

        image:
          generatedFront,

        size:
          selectedSize,

        mode:
          isUserPhotoMode
            ? 'USER_PHOTO'
            : 'MODEL'

      });

    }


    // --------------------------------------------------------
    // RETURN ONLY FRONT
    // --------------------------------------------------------

    return generatedFront;


  } catch (error) {

    console.error(
      "Men's Front Generation Failed:",
      error
    );


    throw error;

  }

}


// ============================================================
// EXPORT
// ============================================================

module.exports = {

  generateFrontCatalog,
  normalizeTryOnInputs,
  prepareReferenceImages,
  resolveBaseModelReference,
  callGeminiImageGen

};
