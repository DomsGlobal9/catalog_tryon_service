# ScaleEasy Catalog Try-On API Documentation

This document provides comprehensive technical details for integrating with the **ScaleEasy Catalog Try-On Microservice**. This API generates high-fidelity, studio-quality 4-view catalog images (Front, Back, Side, Sitting) using Gemini 3.1 Flash Image.

---

## 🚀 Base URL
**Production:** `https://catalog-tryon-microservice.onrender.com`  
**Local Development:** `http://localhost:4005`

---

## 🔒 Authentication
All requests require an API key passed in the headers.

| Header Key | Value | Description |
| :--- | :--- | :--- |
| `x-api-key` | `se_catalog_internal_key_v1_99283` | Internal security key |
| `Content-Type`| `application/json` | Required for the payload |

---

## 📡 Endpoint: Generate Catalog
**`POST /api/v1/draping/generate-catalog`**

This endpoint accepts base64-encoded garment images and streams back the generated model images in real-time using Server-Sent Events (SSE).

### Request Payload (JSON)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `clientId` | String | **Yes** | Identifier for the client/tenant (e.g., `"frontend-test-suite"`). |
| `modelId` | String | **Yes** | The exact ID of the AI Model to use (see *Available Model IDs* below). |
| `category` | String | No | Defaults to `"SAREE"`. Valid options: `"SAREE"`, `"KURTI"`, `"ANARKALI"`, `"LEHANGA"`, `"SHARARA"`. |
| `saree` / `full` / `fullDress` | String | **Yes** | Base64 encoded image of the primary garment (flat-lay or worn). |
| `blouse` / `top` / `topFront`| String | No | Base64 encoded image of the top/blouse. |
| `bottom` | String | No | Base64 encoded image of the pants/skirt (if applicable). |

### Example Request (Saree)
For Sarees, the API expects `saree` and `blouse` keys.
```json
{
  "clientId": "frontend-test-suite",
  "modelId": "saree1",
  "category": "SAREE",
  "saree": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA...",
  "blouse": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA..."
}
```

### Example Request (Kurti, Lehanga, Anarkali, Sharara)
For generic 3-piece sets, the API expects `full` (or `fullDress`), `top`, and `bottom` keys.
```json
{
  "clientId": "frontend-test-suite",
  "modelId": "kurti1",
  "category": "KURTI",
  "full": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA...",
  "top": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA...",
  "bottom": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA..."
}
```

---

## 🎭 Available Model IDs (`modelId`)

The database contains exactly 20 perfectly standardized models. You **MUST** pass one of these exact strings.

*   **Sarees:** `saree1`, `saree2`, `saree3`, `saree4`
*   **Kurtis:** `kurti1`, `kurti2`, `kurti3`, `kurti4`
*   **Anarkalis:** `anarkali1`, `anarkali2`, `anarkali3`, `anarkali4`
*   **Lehangas:** `lehanga1`, `lehanga2`, `lehanga3`, `lehanga4`
*   **Shararas:** `sharara1`, `sharara2`, `sharara3`, `sharara4`

---

## 📥 Response Format (Server-Sent Events)

Because image generation takes 30-90 seconds for all 4 views, this API does **not** return a standard JSON response. It streams the response using **Server-Sent Events (SSE)** (`text/event-stream`).

You will receive multiple chunks separated by `\n\n`. Each chunk contains a JSON string prefixed with `data: `.

### Event Types:

**1. `STATUS`** - Emitted when a generation step starts.
```json
{
  "type": "STATUS",
  "message": "Generating Front View..."
}
```

**2. `VIEW_READY`** - Emitted the millisecond a specific view is generated. Contains the Base64 output.
```json
{
  "type": "VIEW_READY",
  "view": "FRONT",
  "image": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA..."
}
```
*(Valid `view` values: `FRONT`, `BACK`, `SIDE`, `SITTING`)*

**3. `COMPLETE`** - Emitted when the entire 4-view generation is finished.
```json
{
  "type": "COMPLETE",
  "jobId": "uuid-string..."
}
```

**4. `ERROR`** - Emitted if the generation fails.
```json
{
  "type": "ERROR",
  "error": "Gemini API timeout..."
}
```

---

## 💻 Example Implementation (JavaScript Fetch)

Here is production-ready code to consume the SSE stream on the frontend:

```javascript
async function generateDrape() {
  const url = "https://catalog-tryon-microservice.onrender.com/api/v1/draping/generate-catalog";
  
  const payload = {
    clientId: "my-app",
    modelId: "saree1",
    category: "SAREE",
    saree: "base64_string_here..."
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "se_catalog_internal_key_v1_99283"
    },
    body: JSON.stringify(payload)
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let chunks = buffer.split("\n\n");
    buffer = chunks.pop(); // Keep incomplete chunk in buffer

    for (let chunk of chunks) {
      if (chunk.startsWith("data: ")) {
        const data = JSON.parse(chunk.substring(6));
        
        if (data.type === 'STATUS') {
          console.log("Status:", data.message);
        } else if (data.type === 'VIEW_READY') {
          console.log(`${data.view} view is ready!`);
          // Example: setImage(data.image);
        } else if (data.type === 'COMPLETE') {
          console.log("All views generated successfully.");
        } else if (data.type === 'ERROR') {
          console.error("API Error:", data.error);
        }
      }
    }
  }
}
```

---

## 🛠 Architecture & Data Policies

*   **Zero-Retention Policy:** This API operates strictly on a Base64-in, Base64-out model. We do **NOT** save or host the uploaded user garments or the generated AI output images on our servers.
*   **Studio Consistency:** The AI uses an advanced spatial constraint (`sys-constants.js`) to guarantee the exact same background studio wall and floor across all 4 generated views.
*   **Database (Supabase):** The API connects to a PostgreSQL database exclusively to fetch the Base Model image URLs and log job latency metadata. It does not store user data.
