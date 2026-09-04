// =============================================================================
// sys-constants.js
// =============================================================================

const CATEGORY_GUIDES = {
  FORMALS: {
    title: 'formal classic menswear',
    fit: 'refined, tailored, premium business formality',
    details: 'sharp collar structure, crisp silhouette, elegant finishing, polished premium look'
  },
  BLAZER: {
    title: 'smart blazer outfit',
    fit: 'structured, elevated, contemporary business-casual',
    details: 'clean lapels, balanced proportions, premium fabric texture, modern masculine silhouette'
  },
  KURTA_PAJAMA: {
    title: 'kurta pajama ensemble',
    fit: 'festive, comfortable, traditional but polished',
    details: 'classic Indian festive tailoring, elegant drape, refined collar, premium ceremonial finish'
  },
  SHERWANI: {
    title: 'sherwani outfit',
    fit: 'luxury, regal, formal occasion dressing',
    details: 'rich festive structure, elegant royal silhouette, premium traditional finishing'
  }
};

function getDynamicPrompt(view, category, inputSlots = {}, environmentText = '') {
  const normalizedCategory = (category || 'FORMALS').toUpperCase();
  const config = CATEGORY_GUIDES[normalizedCategory] || CATEGORY_GUIDES.FORMALS;

  const hasFullDress = !!inputSlots.hasFullDress;
  const hasTop = !!inputSlots.hasTop;
  const hasBottom = !!inputSlots.hasBottom;
  const hasReference = !!inputSlots.hasReference;

  const garmentText = [
    hasFullDress ? 'The input garment reference is the primary outfit to be placed on the male model.' : null,
    hasTop ? 'The top garment reference should be matched precisely for style and fabric behavior.' : null,
    hasBottom ? 'The bottom garment reference should be matched precisely for silhouette and drape.' : null,
    hasReference ? 'Use the reference image as a visual match for shape and styling.' : null
  ].filter(Boolean).join(' ');

  const prompt = `
You are a high-end fashion image editor generating a premium men's catalog image.

Goal:
Create a realistic ${config.title} for a male model in a clean premium e-commerce studio setup.

Critical instructions:
- Preserve the exact same person, face, identity, skin tone, expressions, and hairstyle from the base model reference image.
- Adjust the body structure and proportions to accurately reflect the selected garment size, while keeping the identity consistent.
- Do not replace the man or alter his identity.
- Keep the original studio background unchanged unless the provided environment instructions explicitly state otherwise.
- Match the garment styling, fit, texture, and silhouette to the provided garment reference as closely as possible.
- Maintain natural realism: accurate fabric drape, natural folds, realistic shadows, and high-end commercial photography quality.
- Keep the final image clean, premium, and suitable for men's apparel catalog presentation.
- Prefer the most polished and believable result for product photography.

Category:
${normalizedCategory} — ${config.fit}. ${config.details}.

Input garment logic:
${garmentText || 'Use the garment image as the primary clothing reference. Keep the outfit realistic and polished.'}

View target:
${view || 'FRONT'} view only.

Environment rules:
${environmentText || 'Use a clean, premium, minimal studio background with soft neutral lighting and realistic shadows.'}

Output quality requirements:
- Photorealistic apparel presentation
- Natural fit and garment drape
- Soft studio lighting with realistic shadow falloff
- Crisp, polished product-shot appearance
- No text, watermark, logo, or extra objects
- No changes to the model identity
`;

  return prompt.trim();
}

module.exports = {
  getDynamicPrompt,
  CATEGORY_GUIDES
};
