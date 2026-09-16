# Design Studio API

Turn the designs and fabrics your user picked into **one finished garment, worn by a model**, in a
single request. You send the design images (a pallu, a border, a blouse neck…), the fabric images and
the garment type; you get back a photorealistic catalogue photograph as base64.

Design Studio does not depend on Design Discovery. Designs can come from discovery results, your own
uploads, or anywhere else — as long as you send them as base64 or Cloudinary links.

| | |
| :--- | :--- |
| **Base URL (production)** | `https://api-super-admin.onrender.com/api/gateway/cat` |
| **Headers** | `x-api-key: <your key>` and `Content-Type: application/json` |
| **Generate** | `POST /api/v1/designstudio/generate` — answers as a live event stream |
| **Cancel** | `POST /api/v1/designstudio/cancel` |
| **Options** | `GET /api/v1/designstudio/options` — garments, design areas and limits |
| **Output** | One JPEG, portrait **3:4**, full length, plain studio background, as base64 |

---

## Request

```json
{
  "clientId": "shop-42-user-9",
  "garment": "SAREE",
  "designs": [
    { "area": "PALLU",  "image": "https://res.cloudinary.com/acme/image/upload/v1/pallu.jpg" },
    { "area": "BORDER", "image": "data:image/jpeg;base64,/9j/4AAQ...", "note": "keep the peacock motifs" }
  ],
  "fabrics": [
    { "image": "https://res.cloudinary.com/acme/image/upload/v1/kanjivaram.jpg", "name": "Kanjivaram silk" },
    { "image": "data:image/jpeg;base64,/9j/4AAQ...", "name": "Gold tissue", "appliesTo": ["PALLU"] }
  ],
  "notes": "festive look"
}
```

| Field | Type | Required | Meaning |
| :--- | :--- | :--- | :--- |
| `clientId` | string, 1–128 | **Yes** | Your identifier for the user or session. Starting a new generation with the same `clientId` stops the previous one. |
| `garment` | string | **Yes** | One of the 12 garment ids: `SAREE`, `BLOUSE`, `DUPATTA`, `KURTHI`, `ANARKALI`, `PETTICOAT`, `GOWN`, `SUIT`, `SHERWANI`, `BOTTOM_WEAR`, `LEHANGA`, `SHARARA`. Common spellings are accepted (`lehenga`, `kurti`). |
| `designs` | array, 1–6 | **Yes** | One entry per design area. |
| `designs[].area` | string | **Yes** | A design area **of that garment**, e.g. `PALLU`, `BORDER`, `BODY` for a saree. See `GET /options`. One design per area. |
| `designs[].image` | string | **Yes** | The design picture. See *Images*. |
| `designs[].note` | string, ≤300 | No | A short instruction for this design only. |
| `fabrics` | array, 0–3 | No | The fabrics to make the garment from. |
| `fabrics[].image` | string | **Yes** | The fabric picture. |
| `fabrics[].name` | string, ≤80 | No | e.g. `"Banarasi Brocade"`. Helps the model understand the material. |
| `fabrics[].material` | string, ≤120 | No | e.g. `"Pure Katan silk with woven zari"`. Decides how the cloth falls and shines. |
| `fabrics[].color` | string, ≤60 | No | The colour in words, e.g. `"Wine / deep magenta with gold zari"`. |
| `fabrics[].colorHex` | string | No | e.g. `"#722F37"`. **A stated colour or hex wins over the photo's shade**, because a fabric photo can be shot in warm or cool light. The photo is still used for the weave, motifs and zari. |
| `fabrics[].itemCode` | string, ≤40 | No | Your stock code. Echoed back in the `start` event so you can match the photo to the item. |
| `fabrics[].appliesTo` | string[] | No | The design areas this fabric is used for. **Leave it out for the main fabric**, which covers every part without its own fabric. Only one fabric can be the main fabric, and each area can have only one fabric. |
| `fabrics[].note` | string, ≤300 | No | A short instruction for this fabric only. |
| `productName` | string, ≤120 | No | e.g. `"Bridal Banarasi Saree"`. Used as a hint to the style and occasion. No text is ever drawn into the image. |
| `modelImage` | string | No | A photo of the person to dress, to keep the same face and body across your products. Without it, a professional model is created for you. |
| `modelGender` | `female` \| `male` | No | Defaults to the garment's usual wearer (`male` for `SHERWANI`, `female` for the rest). |
| `notes` | string, ≤600 | No | Anything else. The reference images always take priority over notes. |

Unknown fields are refused, so a typo never silently does nothing.

### If your payload comes from a product catalogue

These field names are accepted as well, so a request built around a product record needs no
rewriting. Both spellings produce exactly the same result.

| Catalogue name | Same as |
| :--- | :--- |
| `productType`, `garmentType` | `garment` |
| `parts` | `designs` |
| `parts[].type` | `designs[].area` |
| `parts[].designImageUrl`, `parts[].imageUrl` | `designs[].image` |
| `parts[].description` | `designs[].note` |
| `parts[].label` | accepted, not used (your own display name) |
| `fabrics[].imageUrl` | `fabrics[].image` |
| `fabrics[].details.*` | the `fabrics[]` fields themselves (`name`, `material`, `color`/`colour`, `colorHex`, `itemCode`) |
| `fabrics[].details.quantityMeters` | accepted, not used (it cannot change a photograph) |
| `instructions` | `notes` |
| `modelImageUrl` | `modelImage` |

```json
{
  "clientId": "shop-42-user-9",
  "productType": "saree",
  "productName": "Bridal Banarasi Saree",
  "instructions": "luxury boutique look",
  "parts": [
    { "type": "pallu",  "label": "Pallu",  "description": "gold zari peacock motif", "designImageUrl": "https://res.cloudinary.com/acme/image/upload/v1/pallu.jpg" },
    { "type": "border", "label": "Border", "description": "wide temple border",      "designImageUrl": "https://res.cloudinary.com/acme/image/upload/v1/border.jpg" },
    { "type": "body",   "label": "Body",   "description": "small woven butis",       "designImageUrl": "https://res.cloudinary.com/acme/image/upload/v1/body.jpg" }
  ],
  "fabrics": [
    {
      "imageUrl": "https://res.cloudinary.com/acme/image/upload/v1/fab-0003.jpg",
      "appliesTo": ["body"],
      "details": { "itemCode": "FAB-0003", "name": "Banarasi Brocade", "material": "Silk blend with zari work", "color": "Wine / deep magenta", "colorHex": "#722F37", "quantityMeters": 5.5 }
    }
  ]
}
```

`clientId` is still required, and a typo inside `details` is refused with the field named.

### Images

Every image is **either**:

- **base64** — raw, or as a data URI (`data:image/jpeg;base64,...`), **or**
- an **https Cloudinary link** (`https://res.cloudinary.com/...`). No other websites are downloaded.

JPEG, PNG, WebP, AVIF and HEIC are accepted. Each image may be up to **12 MB**, and the whole
request up to **50 MB**. Images at least **1000 px** on their longest side give the best detail; under
512 px works but you will get a warning, and under 64 px is refused.

### What "exact" means

Designs and fabrics are treated as a **strict specification**: the same motifs, colours, spacing and
technique (zari, embroidery, print), placed only in their area, on the exact fabric colour and texture
you sent. Anything else in a reference picture — a person, a background, a watermark — is ignored.
You must have the rights to the designs and fabrics you send.

---

## Response: an event stream

A good request answers `200` with `Content-Type: text/event-stream`. Each event is one line starting
with `data: ` followed by JSON, then a blank line. Lines starting with `:` are keep-alive pings; ignore them.

**Anything wrong with the request is refused before the stream opens**, as ordinary JSON (see
*Errors*). So check the status first: only `200` is a stream.

| `type` | When | Contents |
| :--- | :--- | :--- |
| `start` | Immediately | `jobId`, `garment`, `productName`, `designs`, `fabrics` (with `itemCode` and `color` echoed back), `model` (`generated`/`reference`), `pose`, `aspectRatio`, `warnings` |
| `status` | Each attempt | `stage: "generating"`, `attempt`, `message` |
| `image` | Success | `image` (a `data:image/jpeg;base64,...` URI), `mimeType`, `width`, `height`, `bytes` |
| `done` | After `image` | `status: "ok"`, `attempts`, `timings` (`prepareMs`, `generateMs`, `totalMs`) |
| `error` | Instead of `image` | `code`, `message`, `retryable` |

Every stream ends with either `image` + `done`, or `error`. A generation usually takes **20–60 seconds**.

```text
data: {"type":"start","jobId":"6c1f…","garment":"SAREE","designs":[{"index":0,"area":"PALLU","areaName":"Pallu Design"},{"index":1,"area":"BORDER","areaName":"Border Design"}],"fabrics":[{"index":0,"name":"Kanjivaram silk","appliesTo":"MAIN"},{"index":1,"name":"Gold tissue","appliesTo":["PALLU"]}],"model":"generated","pose":"front","aspectRatio":"3:4","warnings":[]}

data: {"type":"status","stage":"generating","attempt":1,"message":"Generating the garment."}

: keepalive 1757934812345

data: {"type":"image","jobId":"6c1f…","mimeType":"image/jpeg","width":1536,"height":2048,"bytes":612345,"image":"data:image/jpeg;base64,/9j/4AAQ…"}

data: {"type":"done","jobId":"6c1f…","status":"ok","attempts":1,"timings":{"prepareMs":840,"generateMs":31200,"totalMs":32100}}
```

### Warnings

`start.warnings` tells you, in plain words, when the result may not be perfect — for example a design
image under 512 px, or a request with both a `FRONT` and a `BACK` design (one photograph cannot show
both fully; the model is posed to show the back).

### Reading the stream (JavaScript)

The browser's `EventSource` cannot send a POST body or the `x-api-key` header, so read the response
directly:

```js
async function generateGarment(payload, { onEvent, signal } = {}) {
  const res = await fetch(`${BASE_URL}/api/v1/designstudio/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(payload),
    signal
  });

  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
    const { error } = await res.json();          // refused before starting
    throw Object.assign(new Error(error.message), { status: res.status, ...error });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (!frame.startsWith('data: ')) continue;   // keep-alive
      const event = JSON.parse(frame.slice(6));
      onEvent && onEvent(event);
      if (event.type === 'image') result = event;
      if (event.type === 'error') throw Object.assign(new Error(event.message), event);
    }
  }
  return result;                                    // { image: 'data:image/jpeg;base64,...', width, height }
}
```

To stop, abort the request (`AbortController`) or call `/cancel`.

---

## `POST /api/v1/designstudio/cancel`

```json
{ "clientId": "shop-42-user-9" }
```

```json
{ "success": true, "cancelled": true, "message": "Generation cancelled." }
```

`cancelled` is `false` when nothing was running for that `clientId`. You can only cancel your own
generations. The cancelled stream ends with an `error` event whose code is `CANCELLED`.

## `GET /api/v1/designstudio/options`

Everything needed to build a valid request: the 12 garments with their design areas and default model
gender, the limits, and the accepted image sources and formats. Build your pickers from this rather than
hard-coding the lists.

---

## Errors

Before the stream (JSON body `{ "success": false, "error": { "code", "message", "retryable", "details" } }`):

| Status | `code` | Meaning |
| :--- | :--- | :--- |
| `400` | `VALIDATION_ERROR` | Something in the request is wrong. `details[]` names each `field` and a specific `code`: `UNKNOWN_GARMENT`, `UNKNOWN_DESIGN_AREA`, `DUPLICATE_DESIGN_AREA`, `MULTIPLE_MAIN_FABRICS`, `FABRIC_AREA_CONFLICT`, `IMAGE_SOURCE_NOT_ALLOWED`, `INSECURE_URL`, `INVALID_IMAGE_ENCODING`, `IMAGE_TOO_LARGE`, `INVALID_FIELD`. |
| `400` | `INVALID_JSON` | The body is not valid JSON. |
| `401` | — | Missing or wrong `x-api-key`. |
| `413` | `PAYLOAD_TOO_LARGE` | The request is over 50 MB. Send smaller images (a few MB each is plenty). |
| `422` | `IMAGE_UNUSABLE` | One or more images could not be used. `details[]` lists **every** failing image with its `field` and `code`: `IMAGE_NOT_FOUND`, `IMAGE_NOT_ACCESSIBLE`, `IMAGE_DOWNLOAD_FAILED`, `IMAGE_TOO_LARGE`, `IMAGE_TOO_SMALL`, `INVALID_IMAGE`, `UNSUPPORTED_IMAGE_FORMAT`, `IMAGE_SOURCE_NOT_ALLOWED`. |
| `429` | — | Busy, or your hourly generation allowance is used up. Wait for the `Retry-After` header (seconds) and retry. |

Inside the stream (`error` event):

| `code` | Meaning | Retry? |
| :--- | :--- | :--- |
| `GENERATION_BLOCKED` | The image model declined these references (`details.reason`). | No — change the images. |
| `GENERATION_REJECTED` | The image model could not process this input. | No — change the request. |
| `NO_IMAGE_RETURNED` | The model answered without an image, even after a second try. | Yes |
| `MODEL_UNAVAILABLE` | The image model is busy or down (already retried for you). | Yes, shortly |
| `MODEL_QUOTA_EXCEEDED` | The image model has reached its spending cap or quota on this deployment. | No - an operator must raise it |
| `CANCELLED` | You cancelled, or started a new generation with the same `clientId`. | — |
| `INTERNAL_ERROR` | Unexpected failure. | Yes |

---

## Getting the best results

- **Crop each design to the design itself** — a close-up of the pallu, not a whole person wearing a saree.
- **One clear design per area.** Six sharp references beat ten blurry ones.
- **Photograph fabrics flat, in daylight**, filling the frame, so the colour and weave are true.
- **Name your fabrics** (`"Banarasi silk"`, `"georgette"`): it helps the model get the sheen and drape right.
- Use **`appliesTo`** when a fabric is only for part of the garment (a tissue pallu on a silk saree).
- Reuse the same **`modelImage`** across a collection for a consistent look.
