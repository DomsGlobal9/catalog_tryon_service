const sharp = require('sharp');
const { imageInputToBase64 } = require('./menAiService');

const ALL_SIZES = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'];

function cleanBase64(value) {
  if (!value) return null;
  if (typeof value === 'string' && value.startsWith('data:')) {
    return value.split(',')[1];
  }
  return value;
}

function getMimeType(value) {
  if (typeof value === 'string' && value.startsWith('data:')) {
    const match = value.match(/^data:(image\/[^;]+);base64,/);
    if (match) return match[1];
  }
  return 'image/jpeg';
}

function getSizeOptions(recommendedSize) {
  const normalizedSize = String(recommendedSize || 'M').toUpperCase().trim();
  const index = ALL_SIZES.indexOf(normalizedSize);

  if (index === -1) return ['S', 'M', 'L'];
  if (index === 0) return ['S', 'M'];
  if (index === ALL_SIZES.length - 1) return ['XXL', 'XXXL'];
  return [ALL_SIZES[index - 1], ALL_SIZES[index], ALL_SIZES[index + 1]];
}

function buildSizeRecommendationPrompt() {
  return `
You are a clothing fit recommendation assistant for men's apparel.
Analyze the visible body proportions of the person in the uploaded photo.
Recommend ONE approximate ready-to-wear clothing size from S, M, L, XL, XXL or XXXL.
Do not claim exact measurements, identify the person, or include explanations.
Return ONLY valid JSON in this exact format:
{"recommendedSize":"M"}
`;
}

async function requestSizeRecommendation(imageBase64, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');

  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: buildSizeRecommendationPrompt() },
            { inline_data: { mime_type: mimeType, data: imageBase64 } }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json'
        }
      })
    }
  );

  if (!response.ok) {
    // Include what Gemini actually said. Reporting only the status code made a
    // malformed-input bug look like an outage for far longer than it should have.
    let detail = '';
    try { detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 200); } catch { /* ignore */ }
    const err = new Error(`Gemini size recommendation failed: HTTP ${response.status}${detail ? ' - ' + detail : ''}`);
    err.upstreamStatus = response.status;
    throw err;
  }
  return response.json();
}

function parseRecommendedSize(responseData) {
  const responseText = responseData?.candidates?.[0]?.content?.parts
    ?.find(part => part.text)?.text;

  if (!responseText) throw new Error('Gemini did not return a size recommendation.');

  let parsedResult;
  try {
    parsedResult = JSON.parse(responseText);
  } catch (error) {
    throw new Error('Invalid size recommendation response.');
  }

  const recommendedSize = String(parsedResult.recommendedSize || 'M').toUpperCase().trim();
  return ALL_SIZES.includes(recommendedSize) ? recommendedSize : 'M';
}

async function recommendSizeFromPhoto(userPhoto) {
  if (!userPhoto) throw new Error('User photo is required for size recommendation.');

  // Every other endpoint accepts a URL, a data: URI or raw base64. This one used
  // cleanBase64(), which only strips a data: prefix - so a URL was passed through
  // unchanged and sent to Gemini as if it were image bytes, producing an opaque
  // HTTP 400. Use the same URL-aware converter the rest of the men pipeline uses.
  const base64 = await imageInputToBase64(userPhoto);
  if (!base64) throw new Error('Unable to read the supplied user photo.');

  const data = cleanBase64(base64);

  // Read the format from the bytes rather than guessing from the input string.
  // Guessing meant a URL to a JPEG was declared as PNG, so the declared type did
  // not match what was sent.
  let mimeType = 'image/jpeg';
  try {
    const meta = await sharp(Buffer.from(data, 'base64')).metadata();
    if (meta.format) mimeType = 'image/' + (meta.format === 'jpg' ? 'jpeg' : meta.format);
  } catch {
    const guessed = getMimeType(userPhoto);
    if (guessed) mimeType = guessed;
  }

  const responseData = await requestSizeRecommendation(data, mimeType);
  const recommendedSize = parseRecommendedSize(responseData);

  return {
    recommendedSize,
    options: getSizeOptions(recommendedSize)
  };
}

module.exports = {
  recommendSizeFromPhoto,
  getSizeOptions,
  ALL_SIZES
};
