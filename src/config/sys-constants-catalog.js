// =============================================================================
// sys-constants.js — Core AI Prompts and Category Rules
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY-SPECIFIC ETHNIC PROMPTS (Sourced exactly from Tryon Backend)
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY_PROMPTS = {
  'SAREE': `THE SAREE (from Saree Reference):
Faithfully reproduce every detail of the saree. Transfer the exact color palette, weave pattern, embroidery, borders, and motifs EXACTLY as they appear in the Saree Reference.
STRICT ADHERENCE TO REFERENCE (CRITICAL):
- If the uploaded Saree Reference is completely plain with no borders or patterns, the generated saree MUST be completely plain with absolutely NO borders. DO NOT hallucinate, invent, or add any zari borders, gold lines, or patterns that do not exist in the reference.
- If the uploaded Saree Reference DOES have a border, you MUST perfectly maintain the exact thickness, width, and style of the border seen in the reference.
FABRIC PHYSICS: The fabric should drape naturally. It falls perfectly straight down and stops abruptly at the hemline. It does not trail, and it does not pool on the floor. The clean studio floor must be visible directly beneath the hemline.`,
  
'LEHANGA': `THE LEHANGA SET (from Garment Reference):
Faithfully reproduce the Lehenga set.

1. SKIRT (Lehenga): Preserve the exact volume, heavy flare, and pleating of the Lehenga skirt from the reference. Transfer the exact borders, embroidery, and fabric texture.

2. BLOUSE (Choli): Reproduce the exact cut, neckline, and sleeve length of the top/blouse.

3. DUPATTA — SELECTED CUSTOMER DRAPING STYLE:
A separate DUPATTA DRAPE STYLE REFERENCE image is provided when the customer selects a dupatta style.

IMPORTANT: The DUPATTA DRAPE STYLE REFERENCE controls ONLY HOW THE DUPATTA IS DRAPED. It does NOT control the dupatta's color, embroidery, fabric, model, background, or any other garment detail.

When a DUPATTA DRAPE STYLE REFERENCE is provided, you MUST reproduce its exact draping arrangement:
- exact shoulder placement
- exact side of the body where the dupatta is placed
- exact pleat arrangement
- exact direction of the dupatta
- exact front fall
- exact length and hanging position
- exact way the dupatta wraps around or falls over the body

DO NOT replace the selected style with a standard or default dupatta drape.
DO NOT automatically use a front-pleated dupatta.
DO NOT invent a different dupatta arrangement.

If the selected reference shows a single-shoulder drape, reproduce the single-shoulder drape.
If the selected reference shows a traditional front-pleat drape, reproduce the traditional front-pleat drape.

The Lehenga garment reference controls the garment's color, fabric, embroidery, borders and design.
The DUPATTA DRAPE STYLE REFERENCE controls only the dupatta's draping style.

If no dupatta style reference is provided, use the natural dupatta drape visible in the garment reference.`,
  'ANARKALI': `THE ANARKALI SUIT (from Garment Reference):
Faithfully reproduce the Anarkali suit. 
1. SILHOUETTE: Preserve the long, frock-style flared silhouette from the waist down, maintaining the exact fabric volume, weight, and drape. 
2. TOP: Reproduce the fitted bodice, neckline, and sleeves exactly. 
3. BOTTOMS: Preserve the churidar/pants as shown.`,
  
  'SHARARA': `THE SHARARA SUIT (from Garment Reference):
Faithfully reproduce the Sharara suit. 
1. BOTTOMS: It is critical to maintain the unique wide, flared, ruffled structure of the Sharara pants from the knee down. 
2. TOP: Preserve the exact length, side slits, and neckline of the Kurti (tunic).`,
  
  'KURTHI': `THE KURTHI SET (from Garment Reference):
Faithfully reproduce the Kurthi outfit. 
1. TOP: Preserve the exact length of the tunic, the depth of the side slits, the neckline, and the sleeve style. 
2. BOTTOMS: If bottoms (leggings, palazzos, or pants) are visible, reproduce them exactly.`,
  
  'DEFAULT': `THE OUTFIT (from Garment Reference):
Faithfully reproduce every detail of the outfit. Preserve the exact silhouette, neckline, sleeve style, and pant/skirt structure. Transfer the exact color palette, weave pattern, and embroidery. The outfit must conform naturally to the customer's body without altering the customer's proportions.`
};

/**
 * Spelling variants that must resolve to the same prompt.
 *
 * The frontend dropdown and API_DOCUMENTATION both use KURTI, while the prompt
 * map is keyed KURTHI - so every Kurti generation silently fell through to the
 * generic DEFAULT prompt and lost its tunic-length, side-slit, neckline and
 * bottoms rules. It still generated, so nothing ever surfaced; only quality
 * dropped. Same class of trap exists for LEHENGA vs LEHANGA.
 */
const CATEGORY_ALIASES = {
  KURTI: 'KURTHI',
  KURTA: 'KURTHI',
  LEHENGA: 'LEHANGA',
  GHAGRA: 'LEHANGA',
  SARI: 'SAREE',
  GHARARA: 'SHARARA'
};

function getCategoryPrompt(category) {
  if (!category) return CATEGORY_PROMPTS['DEFAULT'];
  const raw = String(category).trim().toUpperCase();
  const normalizedCat = CATEGORY_ALIASES[raw] || raw;
  const prompt = CATEGORY_PROMPTS[normalizedCat];
  if (!prompt) {
    console.warn(`[Prompt] Unknown category "${category}" - falling back to the generic DEFAULT prompt.`);
    return CATEGORY_PROMPTS['DEFAULT'];
  }
  return prompt;
}

// ─────────────────────────────────────────────────────────────────────────────
// VIEW-SPECIFIC INSTRUCTIONS
// ─────────────────────────────────────────────────────────────────────────────
const VIEW_INSTRUCTIONS = {
  FRONT: `
- Drape the garments perfectly onto the model in the Final Image (the Base Model).
- The model is facing forward. Ensure all patterns align logically on the body.`,
  BACK: `
- CONSISTENCY LOCK: The Front-View Reference image shows exactly how this garment looks on this specific model. You MUST perfectly replicate the exact colors, fabric texture, and draping style seen in that reference image.
- CRITICAL DRAPING RULE: Completely IGNORE the default dupatta or draping style visible on the Base Model. You must adapt the dupatta draping strictly from the Front-View Reference image to fit this back view.
- The model is facing away from the camera. Show the intricate back design or fall of the garment naturally.`,
  SIDE: `
- CONSISTENCY LOCK: The Front-View Reference image shows exactly how this garment looks on this specific model. You MUST perfectly replicate the exact colors, fabric texture, and draping style seen in that reference image.
- CRITICAL DRAPING RULE: Completely IGNORE the default dupatta or draping style visible on the Base Model. You must adapt the dupatta draping strictly from the Front-View Reference image to fit this side view.
- The model is standing in a true right-side profile (only the right side is visible).
- Ensure the pattern placement seamlessly wraps around the side of the body exactly as it would based on the reference.`,
  SITTING: `
- CONSISTENCY LOCK: The Front-View Reference image shows exactly how this garment looks on this specific model. You MUST perfectly replicate the exact colors, fabric texture, and draping style seen in that reference image.
- CRITICAL DRAPING RULE: Completely IGNORE the default dupatta or draping style visible on the Base Model. You must adapt the dupatta draping strictly from the Front-View Reference image to fit this sitting pose.
- The garment must drape naturally around the legs and lap, simulating realistic gravity and fabric tension for a seated pose.`
};

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC PROMPT BUILDER
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Constructs the full AI prompt.
 * @param {string} viewType - 'FRONT', 'BACK', 'SIDE', 'SITTING'
 * @param {string} category - 'SAREE', 'LEHANGA', etc.
 * @param {Object} inputSlots - { hasFullDress, hasTop, hasBottom, hasReference }
 * @param {string} environmentPrompt - The randomly selected background description
 */
function getDynamicPrompt(viewType, category, inputSlots, environmentPrompt = '') {
  const categoryInstruction = getCategoryPrompt(category);
  const viewInstruction = VIEW_INSTRUCTIONS[viewType];

  let blouseInstruction = '';
  if (category.toUpperCase() === 'SAREE') {
    if (inputSlots.hasTop) {
      blouseInstruction = `\nTHE BLOUSE (from Blouse Reference — separate image):
A separate blouse image has been provided in the sequence. 
1. Transfer the exact fabric texture, color, and embroidery from this Blouse Reference image.
2. If the reference is unstitched flat fabric, you MUST construct a standard, modest regular neckline (strictly NO collar necks) with standard half-sleeves.
3. If the reference is a stitched blouse, copy its exact neckline and sleeves. 
The blouse must be tailored to fit the model's body naturally. Ignore any blouse visible in the Saree Reference.\n`;
    } else {
      blouseInstruction = `\nTHE BLOUSE (No separate image provided):
CRITICAL: Analyze the Saree Reference image carefully.
1. IF A BLOUSE IS VISIBLE: You MUST copy its exact neckline, sleeve length, color, fabric texture, and embroidery. Reproduce the visible blouse with 100% pixel-perfect accuracy.
2. IF NO BLOUSE IS VISIBLE (e.g. folded fabric flat-lay): You MUST generate a modest, matching blouse (standard round neckline, half-sleeves) that complements the saree. Do NOT leave the model bare.\n`;
    }
  }

  return `[NEGATIVE PROMPTS: trailing fabric, train, extra cloth on floor, plain black fabric below gold border, fabric pooling, messy hemline, cloth dragging on floor, invented borders, added embroidery, extra motifs, hallucinated zari, embellishment not in reference, altered colour, colour shift, oversaturated, restyled garment, different garment, simplified pattern, missing motifs, watermark, text overlay, logo, duplicated limbs, distorted hands, extra fingers, blurry fabric, plastic skin]

You are a professional fashion photographer conducting a catalog shoot for e-commerce.
  
═══════════════════════════════════════════════════════════════════
RULE #1 — ABSOLUTE IDENTITY LOCK (HIGHEST PRIORITY)
═══════════════════════════════════════════════════════════════════
The Base Model's face is FORENSIC EVIDENCE. You are NOT allowed to alter it in any way.
- PRESERVE IDENTITY: The model's face, skin tone, hair style, and body proportions in the output MUST be a 100% exact match to the Base Model image.
- Do not hallucinate or alter the person. Same bone structure, skin tone, and hair.

═══════════════════════════════════════════════════════════════════
RULE #2 — THE GARMENT & CATEGORY RULES
═══════════════════════════════════════════════════════════════════
${categoryInstruction}
${blouseInstruction}
═══════════════════════════════════════════════════════════════════
RULE #2B — FLAT-LAY FIDELITY (APPLIES TO EVERY GARMENT)
═══════════════════════════════════════════════════════════════════
The garment reference is the product being sold. It is a specification, not
inspiration. Reproduce THAT EXACT PIECE — not a similar one, not an improved one.

- ADD NOTHING. Do not invent borders, zari lines, motifs, embroidery, sequins,
  buttons, tassels, lace, piping or any embellishment that is not visibly
  present in the reference. If an area of the reference is plain, it stays plain.
- REMOVE NOTHING. Every motif, border, pattern break and texture visible in the
  reference must appear in the output. Do not simplify busy areas.
- EXACT COLOUR. Match the hue, saturation and tone of the reference precisely.
  Do not brighten, deepen, warm, cool or "correct" the colour.
- EXACT SCALE. Keep motifs and borders in the same proportion to the garment as
  in the reference. A small motif stays small; a narrow border stays narrow.
- EXACT PLACEMENT. Patterns must sit where they sit in the reference, and
  continue logically around the body rather than being redrawn.
- FABRIC BEHAVIOUR. Match the weight and sheen of the reference fabric. A stiff
  fabric must not drape like chiffon, and a matte fabric must not turn glossy.

If any detail of the garment is unclear in the reference, reproduce it as plainly
as possible. Never fill an uncertainty with invention.
═══════════════════════════════════════════════════════════════════
RULE #3 — VIEW SPECIFIC & STUDIO SCENE
═══════════════════════════════════════════════════════════════════
${viewInstruction}
- STUDIO LIGHTING: Use bright, even, professional studio lighting.
- BACKGROUND: ${environmentPrompt || 'The background must be clean, solid, and neutral (like a professional e-commerce studio).'}
- The result must be indistinguishable from a real, unretouched photograph.`;
}

module.exports = {
  getCategoryPrompt,
  getDynamicPrompt
};
