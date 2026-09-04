export const generateCatalog = async ({ fullDress, topFront, bottom, category, dupattaStyleUrl }, onEvent, modelId = "saree1", abortSignal = null) => {
  const isDev = import.meta.env.DEV;
  const url = isDev 
    ? "http://localhost:4005/api/v1/draping/generate-catalog"
    : (import.meta.env.VITE_API_URL || "https://api-super-admin.onrender.com/api/gateway/cat/api/v1/draping/generate-catalog");
  // No key is committed. In dev the frontend talks straight to the local
  // service, which wants its own SERVICE_API_KEY (VITE_DEV_API_KEY here);
  // in production it goes through the gateway, which wants the client key.
  // Both live in frontend/.env, which is gitignored.
  const apiKey = import.meta.env.DEV
    ? import.meta.env.VITE_DEV_API_KEY
    : import.meta.env.VITE_API_KEY;

  let payload = {
    clientId: "frontend-test-suite",
    modelId: modelId,
    category: "women",
    garmentCategory: category,
  };
  if (category === 'LEHANGA' && dupattaStyleUrl) {
  payload.dupattaStyleUrl = dupattaStyleUrl;
}

  if (category === 'SAREE') {
    payload.saree = fullDress;
    payload.blouse = topFront;
  } else {
    payload.full = fullDress;
    payload.top = topFront;
    payload.bottom = bottom;
  }

    // If the frontend uses an AbortController, automatically send a kill signal to the backend!
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        cancelGeneration("frontend-test-suite");
      });
    }

  try {

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify(payload),
      signal: abortSignal
    });

    if (!response.ok) {
      let errText = await response.text();
      try { errText = JSON.parse(errText).error || errText; } catch(e){}
      throw new Error(`Failed to generate catalog: ${errText}`);
    }

    if (!response.body) {
      throw new Error("ReadableStream not supported in this browser.");
    }

    // Process the SSE ReadableStream
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      
      // Parse SSE chunks separated by \n\n
      let chunks = buffer.split("\n\n");
      buffer = chunks.pop(); // Keep the last incomplete chunk in the buffer

      for (let chunk of chunks) {
        if (chunk.startsWith("data: ")) {
          const jsonStr = chunk.substring(6).trim();
          if (jsonStr) {
            try {
              const eventData = JSON.parse(jsonStr);
              if (eventData.type === 'ERROR') {
                throw new Error(eventData.error);
              }
              onEvent(eventData);
            } catch (e) {
              if (e.message !== "Unexpected end of JSON input") {
                 console.error("Failed to parse stream JSON:", jsonStr, e);
              }
              if (e.message.includes('Gemini API Error')) throw e; // Bubble up API errors
            }
          }
        }
      }
    }
    
    return { success: true };

  } catch (error) {
    console.error("API Error:", error);
    throw error;
  }
};

export const cancelGeneration = async (clientId = "frontend-test-suite") => {
  // This MUST branch on DEV exactly like generateCatalog above. It used to read
  // VITE_API_URL unconditionally, so in dev it aimed at the PRODUCTION gateway
  // while sending the LOCAL service key. The gateway answered
  // {"code":"UNAUTHORIZED_API_KEY","message":"Invalid API Key"} and - worse -
  // the local job was never cancelled and kept holding its admission slot.
  //
  // Read import.meta.env.DEV directly: isDev is scoped to generateCatalog.
  const isDevEnv = import.meta.env.DEV;
  const url = isDevEnv
    ? "http://localhost:4005/api/v1/draping/generate-catalog"
    : (import.meta.env.VITE_API_URL || "https://api-super-admin.onrender.com/api/gateway/cat/api/v1/draping/generate-catalog");
  const cancelUrl = url.replace('/generate-catalog', '/cancel-job');

  // No key is committed. In dev the frontend talks straight to the local
  // service, which wants its own SERVICE_API_KEY (VITE_DEV_API_KEY here);
  // in production it goes through the gateway, which wants the client key.
  // Both live in frontend/.env, which is gitignored.
  const apiKey = isDevEnv
    ? import.meta.env.VITE_DEV_API_KEY
    : import.meta.env.VITE_API_KEY;

  try {
    await fetch(cancelUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify({ clientId }),
      keepalive: true
    });
  } catch (error) {
    console.error("Failed to send cancellation signal", error);
  }
};
