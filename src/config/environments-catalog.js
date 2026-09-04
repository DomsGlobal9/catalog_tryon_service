// =============================================================================
// environments.js — Premium 3D Background Environments for AI Catalog Generation
// =============================================================================

/**
 * A curated list of premium, high-fidelity background environments.
 * These are injected into the 'BACKGROUND' rule of the generation prompt.
 * 
 * CRITICAL RULE: These prompts are strictly for the background. They must not 
 * influence the model's identity, pose, or the garment's flat-lay design.
 */
const ENVIRONMENTS = [
  // ── ARCHITECTURAL & STUDIO PROPS ──────────────────────────────────────────
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a minimalist wooden stool with clean, modern lines placed slightly behind and to the side of the model.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a small, low white marble display podium sitting quietly on the floor to the model's left.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a classic mid-century modern rattan chair sitting out of focus in the deep background.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a geometric plaster column, fluted and painted matte white, standing on the side of the frame.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a soft, pastel-toned velvet ottoman pouf resting on the floor beside the model.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: an antique brass standing mirror frame leaning casually against the studio wall in the background.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a small, round side table with a neat stack of 3 premium fashion art books.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a clear, transparent acrylic display cube catching soft studio light on the floor.",

  // ── TEXTURES & RUGS ───────────────────────────────────────────────────────
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a natural, hand-braided circular jute rug placed beautifully beneath the model's feet.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a vintage Persian carpet with faded, warm earthy tones placed on the floor under the model.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a sheer, airy linen curtain panel hanging vertically from the top of the frame in the far background.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a beautifully carved antique wooden door panel acting as a leaning decorative backdrop in the corner.",

  // ── BOTANICAL & VASES ─────────────────────────────────────────────────────
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a tall, textured clay ceramic vase holding a large arrangement of dried pampas grass on the floor.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a large, lush potted indoor ficus tree standing on the right side of the frame.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a large, smooth grey river stone resting on the floor beside a small, minimalist terracotta succulent pot.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a tall, sleek matte-black vase holding a single, large glossy green tropical monstera leaf.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Only add this single prop: a short, wide frosted-glass vase holding a pristine arrangement of white peonies on the floor.",

  // ── LIGHTING & SHADOW EFFECTS (NO PHYSICAL PROPS) ─────────────────────────
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Do not add any physical props, just add this lighting effect: a subtle, elegant shadow of a palm frond cast diagonally on the back wall.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Do not add any physical props, just add this lighting effect: a soft, diffused projection of window light and blind shadows on the studio wall.",
  
  "CRITICAL BACKGROUND RULE: PRESERVE THE EXACT SAME BACKGROUND COLOR AND WALL FROM THE BASE MODEL REFERENCE IMAGE. DO NOT ALTER IT IN ANY WAY. Do not add any physical props, just add this lighting effect: a subtle, warm spotlight creating a gentle glowing halo on the wall directly behind the model."
];

module.exports = {
  ENVIRONMENTS
};
