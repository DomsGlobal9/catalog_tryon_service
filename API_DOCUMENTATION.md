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

## 🛑 Endpoint: Cancel Job
**`POST /api/v1/draping/cancel-job`**

This endpoint forcefully terminates a running AI generation pipeline on the backend. Because the `generate-catalog` endpoint is a long-running streaming request, reverse proxies (like Next.js Gateway) can sometimes hide client disconnects from the backend. **You should always call this endpoint if the user clicks "Stop" or refreshes the page mid-generation.**

### Request Payload (JSON)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `clientId` | String | **Yes** | The exact same `clientId` used to start the generation. |

### Example Request
```json
{
  "clientId": "frontend-test-suite"
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
  "view": "front",
  "image": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA..."
}
```
*(Valid `view` values: `front`, `back`, `side`, `sitting`)*

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

## 🔎 Design Discovery API

A **separate capability** hosted by the same service. It takes keywords, searches the web for
matching garment designs, and returns **references** to what it found.

> **Discovery is browse-only.** It returns designs *found on the web* — it does not assert that any
> result is licensed, approved, or cleared for use. It never downloads, stores, or transforms an
> image, and it does not feed the catalog generation pipeline. Every result carries `sourceUrl` and
> `sourceDomain`; **responsibility for rights in any downstream use rests with the caller.**

If a caller's own workflow later wants to generate a catalog from a design, it does so by calling
`/api/v1/draping/generate-catalog` itself — that endpoint already accepts either a public image URL
or base64.

---

### 📡 Endpoint: Search Designs
**`POST /api/v1/discovery/search`**

#### Request Payload (JSON)

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `clientId` | String | **Yes** | Identifier for the client/tenant. Also the rate-limit bucket. |
| `keywords` | String[] | **Yes** | 1–12 search terms, e.g. `["red", "bridal", "saree"]`. |
| `category` | String | No | One of `SAREE`, `LEHANGA`, `ANARKALI`, `SHARARA`, `KURTHI`. Case-insensitive. |
| `filters.color` | String | No | e.g. `"red"`. Folded into the search query. |
| `filters.fabric` | String | No | e.g. `"silk"`. |
| `filters.occasion` | String | No | e.g. `"wedding"`. |
| `shotType` | String | No | `flatlay`, `worn`, or `any` (default). See note below. |
| `page` | Number | No | 1–20. Defaults to `1`. |
| `limit` | Number | No | 1–50. Defaults to `20`. |

**On `shotType`:** a bare `"red bridal saree"` search returns mostly on-model editorial photos.
Pass `"flatlay"` to bias toward flat product photography, which is what a downstream garment
pipeline generally wants.

#### Example Request
```json
{
  "clientId": "acme-retail",
  "keywords": ["red", "bridal", "saree"],
  "category": "SAREE",
  "filters": { "fabric": "silk", "occasion": "wedding" },
  "shotType": "flatlay",
  "page": 1,
  "limit": 20
}
```

#### Response
```json
{
  "success": true,
  "searchId": "b1f2c3d4-...",
  "query": "red bridal saree silk wedding flat lay product photo",
  "cached": false,
  "results": [
    {
      "id": "result_9f2a1c7b4e10",
      "position": 1,
      "title": "Red Bridal Kanjivaram Saree",
      "imageUrl": "https://example.com/images/saree-123.jpg",
      "thumbnailUrl": "https://encrypted-tbn0.gstatic.com/...",
      "sourceUrl": "https://example.com/product/123",
      "sourceDomain": "example.com",
      "width": 1200,
      "height": 1600
    }
  ],
  "pagination": { "page": 1, "limit": 20, "hasMore": true }
}
```

Two fields that mean less than they might appear to:

- **`searchId` is a correlation id for log tracing only.** This service holds no database, so there is
  nothing to fetch by that id later.
- **`hasMore` is inferred, not authoritative.** The upstream provider reports no total result count, so
  a full page is the only available signal that more may exist.

`id` is a stable hash of `imageUrl`, so the same design keeps the same id across repeated searches.

Results are filtered before return: entries without an image URL are dropped, duplicates by image URL
are collapsed, and images the provider reports as smaller than 400×400 are discarded. Results with an
unreported size are kept.

---

### 📋 Endpoint: List Categories
**`GET /api/v1/discovery/categories`**

Returns the garment vocabulary and request limits this deployment accepts. No payload.

```json
{
  "success": true,
  "categories": ["SAREE", "LEHANGA", "ANARKALI", "SHARARA", "KURTHI"],
  "shotTypes": ["flatlay", "worn", "any"],
  "limits": { "maxLimit": 50, "maxPage": 20 }
}
```

---

### ⚠️ Discovery Error Codes

| Status | `error.code` | Meaning |
| :--- | :--- | :--- |
| `400` | `VALIDATION_ERROR` | Body failed validation. `error.details` lists the offending fields. |
| `400` | `INVALID_JSON` | Body was not valid JSON. |
| `401` | — | Missing or wrong `x-api-key`. |
| `413` | `PAYLOAD_TOO_LARGE` | Body exceeded the 32 KB discovery limit. |
| `429` | `RATE_LIMIT_EXCEEDED` | Per-client search budget exhausted. Honour the `Retry-After` header. |
| `424` | `PROVIDER_UNAVAILABLE` | The upstream search provider failed, timed out, or rejected us. |
| `424` | `DISCOVERY_NOT_CONFIGURED` | Discovery is switched off on this deployment (no `SERPER_API_KEY`). |

**Why 424 and not 503.** This service shares a gateway slug with catalog generation, and the gateway
runs a per-slug circuit breaker that trips on repeated `5xx` responses. Reporting an upstream search
outage as `5xx` would take `generate-catalog` offline as collateral damage. Discovery therefore
reports every anticipated failure — including provider outages — as a `4xx`.

Error responses are shaped `{ "success": false, "error": { "code", "message", "details"? } }`.

---

### 🔧 Operational Notes

- **Caching.** Identical queries are served from an in-process cache (default TTL 1 hour) so repeat
  searches do not re-bill the provider. Cached responses set `"cached": true`. The cache is
  per-process: it empties on restart and does not coordinate across instances.
- **Rate limiting.** Default 20 searches/minute per `clientId`, counted whether or not the response
  came from cache. This protects the search-provider budget; the gateway separately enforces its own
  500 requests / 5 minutes per client.
- **Discovery can be switched off.** If `SERPER_API_KEY` is absent the service still boots, logs a
  warning, and serves catalog generation normally; only `/api/v1/discovery/*` returns `424`.

---

## 🛠 Architecture & Data Policies

*   **Zero-Retention Policy:** This API operates strictly on a Base64-in, Base64-out model. We do **NOT** save or host the uploaded user garments or the generated AI output images on our servers.
*   **Studio Consistency:** The AI uses an advanced spatial constraint (`sys-constants.js`) to guarantee the exact same background studio wall and floor across all 4 generated views.
*   **Database (Supabase):** The API connects to a PostgreSQL database exclusively to fetch the Base Model image URLs and log job latency metadata. It does not store user data.
