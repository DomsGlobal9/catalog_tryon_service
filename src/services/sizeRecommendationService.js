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
    throw new Error(`Gemini size recommendation failed: HTTP ${response.status}`);
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

  const responseData = await requestSizeRecommendation(
    cleanBase64(userPhoto),
    getMimeType(userPhoto)
  );
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
