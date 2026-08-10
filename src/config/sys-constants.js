// =============================================================================
// sys-constants.js — Core AI Prompts and Category Rules
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY-SPECIFIC ETHNIC PROMPTS (Sourced exactly from Tryon Backend)
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY_PROMPTS = {
  'SAREE': `THE SAREE (from Saree Reference):
Faithfully reproduce every detail of the saree draping. Preserve the complete pallu with its full length and natural fall over the shoulder, maintain every pleat at the waist with their exact crispness, and keep the precise wrapping pattern around the body. Transfer the exact color palette, weave pattern, embroidery, zari borders, and motifs.
FABRIC PHYSICS (CRITICAL): The fabric is a stiff, heavy, structured Kanjivaram silk that falls perfectly straight down and stops abruptly. It does not flow, it does not trail, and it does not pool on the floor. 
CRITICAL BORDER RULE: The fabric is cut exactly at the woven zari border. The zari border is the absolute lowest part of the saree and the pallu. There is absolutely no plain fabric extending below the zari border at the bottom hem or the pallu. The border itself is the final edge touching the air. The clean studio floor must be visible directly beneath the gold border, proving no fabric extends past it.
PRESERVE EXACT BORDER THICKNESS: You MUST perfectly maintain the exact thickness/width of the border seen in the reference. If the reference has a small/thin border, the generated garment MUST have exactly that small/thin border. Do not enlarge, exaggerate, or stretch the border.`,
  
  'LEHANGA': `THE LEHANGA SET (from Garment Reference):
Faithfully reproduce the Lehenga set. 
1. SKIRT (Lehenga): Preserve the exact volume, heavy flare, and pleating of the Lehenga skirt from the reference. Transfer the exact borders, embroidery, and fabric texture.
2. BLOUSE (Choli): Reproduce the exact cut, neckline, and sleeve length of the top/blouse.`,
  
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

function getCategoryPrompt(category) {
  if (!category) return CATEGORY_PROMPTS['DEFAULT'];
  const normalizedCat = category.toUpperCase();
  return CATEGORY_PROMPTS[normalizedCat] || CATEGORY_PROMPTS['DEFAULT'];
}

// ─────────────────────────────────────────────────────────────────────────────
// VIEW-SPECIFIC INSTRUCTIONS
// ─────────────────────────────────────────────────────────────────────────────
const VIEW_INSTRUCTIONS = {
  FRONT: `
- Drape the garments perfectly onto the model in the Final Image (the Base Model).
- The model is facing forward. Ensure all patterns align logically on the body.`,
  BACK: `
- CONSISTENCY LOCK: The Last Image (Reference) shows exactly how this garment looks on this specific model. You MUST perfectly replicate the exact colors, fabric texture, and draping style seen in that reference image.
- The model is facing away from the camera. Show the intricate back design or fall of the garment naturally.`,
  SIDE: `
- CONSISTENCY LOCK: The Last Image (Reference) shows exactly how this garment looks on this specific model. You MUST perfectly replicate the exact colors, fabric texture, and draping style seen in that reference image.
- The model is standing in a true right-side profile (only the right side is visible).
- Ensure the pattern placement seamlessly wraps around the side of the body exactly as it would based on the reference.`,
  SITTING: `
- CONSISTENCY LOCK: The Last Image (Reference) shows exactly how this garment looks on this specific model. You MUST perfectly replicate the exact colors, fabric texture, and draping style seen in that reference image.
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

  return `[NEGATIVE PROMPTS: trailing fabric, train, extra cloth on floor, plain black fabric below gold border, fabric pooling, messy hemline, cloth dragging on floor]

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
