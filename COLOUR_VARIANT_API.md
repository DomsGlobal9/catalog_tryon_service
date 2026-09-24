# Colour Variants API — the same garment in another colour

**Endpoint:** `POST /api/v1/draping/generate-catalog/women` (also reachable as `POST /api/v1/draping/generate-catalog`)
**Version:** 24 September 2026 · service commit `826e3d8`

You have a picture of a product in one colour. The product is sold in several. Send the picture with a `color` and you get the full four-view catalog (front, back, side, sitting) of the **same garment in that colour**: the base fabric changes, and nothing else does. Gold or silver zari stays metallic, embroidery and motifs keep their colours, size and placement, the border and the blouse keep their own colour unless you say otherwise, and the model, pose and background are the same as they would be without `color`.

This is not a new endpoint. It is one optional field on the women's catalog endpoint. Leave `color` out and the request behaves exactly as before.

---

## 1. Connecting

| | |
| :--- | :--- |
| **Production (via gateway)** | `https://api-super-admin.onrender.com/api/gateway/cat/api/v1/draping/generate-catalog/women` |
| **Direct / local** | `http://localhost:4005/api/v1/draping/generate-catalog/women` |
| **Method** | `POST` |
| **Headers** | `x-api-key: <your key>` · `Content-Type: application/json` |
| **Response** | Server-Sent Events stream (`text/event-stream`), see section 4 |

Gateway limits: one request is closed after **90 seconds**, and the body may be at most **50 MB**. A missing or wrong key returns `401`.

---

## 2. Request payload

### 2.1 Fields

| Field | Type | Required | Notes |
| :--- | :--- | :--- | :--- |
| `clientId` | String | **Yes** | Your identifier for the user or session. **Use a different `clientId` for each colour** — a new request with the same `clientId` cancels the previous job. |
| `modelId` | String | **Yes** | One of the 22 model IDs (`saree1`–`saree4`, `kurti1`–`kurti4`, `anarkali1`–`anarkali4`, `lehanga1`–`lehanga4`, `sharara1`–`sharara4`, `lehenga_single_shoulder`, `lehenga_traditional_front_pleat`). Unknown ID → `404`. |
| `saree` / `full` / `fullDress` | String | **Yes** | The garment picture: a public image URL, raw base64, or a `data:` URI. The first non-empty of the three wins. |
| `blouse` / `top` / `topFront` | String | No | A separate blouse or top picture, same forms. |
| `bottom` | String | No | Skirt or pants picture, same forms. |
| `category` | String | No | `SAREE` (default), `LEHANGA`, `ANARKALI`, `SHARARA`, `KURTI`. Spelling variants (`LEHENGA`, `KURTHI`, `SARI`) are accepted. |
| `dupattaStyleUrl` | String | No | `LEHANGA` only. |
| **`color`** | String or Object | No | **The colour variant.** See 2.2. `colour` and `colorVariant` are accepted as aliases for the same field. |

### 2.2 The `color` field

Three forms are accepted. Send the name **and** the hex when you have both: the name steers the image model, the hex is passed as a reference.

| Form | Example | What the service does |
| :--- | :--- | :--- |
| Object, name and hex | `{ "name": "Royal Blue", "hex": "#2745A8" }` | Uses both. Best results. |
| Hex only | `"#2745A8"` or `{ "hex": "#2745A8" }` | Works out the nearest colour name and uses it (`#2745A8` → *Royal Blue*, `#0F5132` → *Bottle Green*, `#6D1A36` → *Wine*). `#RGB` short form is accepted. Case does not matter. |
| Name only | `"Bottle Green"` or `{ "name": "Bottle Green" }` | Uses the name as it is. |

Rules for `name`: letters, spaces, hyphens and apostrophes only, up to 60 characters. Rules for `hex`: `#RRGGBB` or `#RGB`, with or without the `#`.

### 2.3 Optional switches (object form only)

| Switch | Type | Default | When `false` (default) | When `true` |
| :--- | :--- | :--- | :--- | :--- |
| `border` | Boolean | `false` | The border keeps its own colour, width and style. Its plain selvedge band too. | The border is recoloured with the body. Its zari, motifs, width and style still stay as they are. |
| `blouse` | Boolean | `false` | The blouse (choli or top for a lehenga or suit) keeps its own colour and design. | The blouse is recoloured to match. Its neckline, sleeves and embroidery stay as they are. |

The strings `"true"` and `"false"` are accepted for these too.

**What never changes, whatever you set:** gold or silver zari, metallic thread, sequins and stones stay metallic; embroidery, prints and woven motifs keep their colours, size, spacing and placement; fabric texture, weave, sheen, folds and drape; the model, pose, background, lighting and framing.

### 2.4 Example requests

Saree in royal blue, garment as a URL, everything else default:

```json
{
  "clientId": "shop-42-blue",
  "modelId": "saree1",
  "category": "SAREE",
  "saree": "https://cdn.shop/green-silk-saree.jpg",
  "color": { "name": "Royal Blue", "hex": "#2745A8" }
}
```

Shortest form, hex only:

```json
{ "clientId": "shop-42-green", "modelId": "saree1", "saree": "https://cdn.shop/red-saree.jpg", "color": "#0B6E4F" }
```

Lehenga set recoloured as a whole (skirt, choli and border), garment as base64:

```json
{
  "clientId": "shop-42-wine",
  "modelId": "lehanga2",
  "category": "LEHANGA",
  "full": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA...",
  "color": { "name": "Wine", "hex": "#6D1A36", "border": true, "blouse": true }
}
```

Several colours of one product: one request per colour, different `clientId` each, run them one after another or in parallel as your capacity allows.

```json
[
  { "clientId": "sku-991-red",   "modelId": "saree2", "saree": "https://cdn.shop/sku-991.jpg", "color": "#C8102E" },
  { "clientId": "sku-991-green", "modelId": "saree2", "saree": "https://cdn.shop/sku-991.jpg", "color": "#0B6E4F" },
  { "clientId": "sku-991-blue",  "modelId": "saree2", "saree": "https://cdn.shop/sku-991.jpg", "color": "#2745A8" }
]
```

Tip: to get the product's **original** colour in the same plain studio as its variants, send it as a variant too, with its own colour.

---

## 3. What the service does with it

1. **Validates `color` first.** A colour it cannot read is refused as a JSON `400` before any generation slot is taken or any AI call is made (section 5).
2. **Makes the front view in the new colour.** The recolour rule is part of the front-view prompt: the base fabric takes the target colour; zari, embroidery, motifs, border and blouse are each told to keep theirs, and the blouse and border are told outright which colour they must **not** become.
3. **Makes back, side and sitting from that front.** These three views never see the original picture; they copy the finished front. So the colour is decided once and the four views cannot disagree.
4. **Pins the background.** Without `color`, each catalog gets a random studio prop. With `color`, every request uses the same plain, prop-free studio, so all the colours of one product sit in the same setting.
5. **Reports the colour back**, with `colorAccuracy: "approximate"` (section 4).

Cost: **4 image calls**, the same as a catalog without `color`. Time: **28–110 s** measured (section 7). The server can be switched to a 5-call mode that recolours the finished front in a separate pass; that is a server setting (`COLOUR_VARIANT_MODE=pass`), not a request field, and the stream looks the same apart from one extra `STATUS` event.

---

## 4. Response — the SSE stream

`200 OK`, `Content-Type: text/event-stream`. Each event is one `data: {...}` line followed by a blank line. Two things every consumer must handle: **keepalive comment lines** (`: keepalive 1757000000000`, skip anything not starting with `data: `) and **views arriving out of order** (`front` is always first; `back`, `side` and `sitting` finish in any order, so key your state by `event.view`).

### 4.1 Event sequence

| # | Event | When | Only with `color`? |
| :--- | :--- | :--- | :--- |
| 1 | `STATUS` | The pipeline starts | no |
| 2 | `COLOR_VARIANT` | Right after the first `STATUS` | **yes** |
| 3 | `VIEW_READY` (`front`) | The front is ready, about 10–30 s in | no |
| 4–6 | `VIEW_READY` (`back`, `side`, `sitting`) | Each as it finishes, any order | no |
| 7 | `COMPLETE` | All four done. Carries `colorVariant`. | field only with `color` |
| — | `ERROR` | Instead of the rest, if generation fails after the stream opened | no |

In the server's 5-call mode a second `STATUS` (`"Recolouring the front view to Royal Blue..."`) appears between 2 and 3.

### 4.2 Events in full

**`STATUS`**
```json
{ "type": "STATUS", "message": "Starting AI Generation Pipeline..." }
```

**`COLOR_VARIANT`** — what the service understood from your `color`.
```json
{
  "type": "COLOR_VARIANT",
  "requestedColor": "#2745A8",
  "colorName": "Royal Blue",
  "colorHex": "#2745A8",
  "colorAccuracy": "approximate",
  "recolourBorder": false,
  "recolourBlouse": false
}
```

| Field | Meaning |
| :--- | :--- |
| `requestedColor` | The hex you sent, or the name if you sent no hex. |
| `colorName` | The name used to make the picture. Worked out from the hex if you sent no name. Title case. |
| `colorHex` | The hex, normalised to `#RRGGBB`, or `null` if you sent only a name. |
| `colorAccuracy` | Always `"approximate"`. See section 6. |
| `recolourBorder`, `recolourBlouse` | The switches as understood. |

**`VIEW_READY`** — one per view. The image is a base64 data URI, JPEG, about 895×1200, 380–580 KB.
```json
{ "type": "VIEW_READY", "view": "front", "image": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA..." }
```
`view` is one of `front`, `back`, `side`, `sitting`.

**`COMPLETE`** — with `color`, it repeats the summary as `colorVariant` so you can store it with the images.
```json
{
  "type": "COMPLETE",
  "jobId": "720d57f8-8149-4202-9896-8c6aa061e44b",
  "colorVariant": {
    "requestedColor": "#0B6E4F",
    "colorName": "Emerald Green",
    "colorHex": "#0B6E4F",
    "colorAccuracy": "approximate",
    "recolourBorder": false,
    "recolourBlouse": false
  }
}
```
Without `color`: `{ "type": "COMPLETE", "jobId": "..." }`, no `colorVariant` field.

**`ERROR`** — generation failed after the stream opened. The stream then closes.
```json
{ "type": "ERROR", "error": "Gemini API Error: HTTP 500 - ..." }
```

### 4.3 A real stream, as measured

Red Banarasi saree → Emerald Green `#0B6E4F`, `saree1`, 24 September 2026:

```
data: {"type":"STATUS","message":"Starting AI Generation Pipeline..."}

data: {"type":"COLOR_VARIANT","requestedColor":"#0B6E4F","colorName":"Emerald Green","colorHex":"#0B6E4F","colorAccuracy":"approximate","recolourBorder":false,"recolourBlouse":false}

data: {"type":"VIEW_READY","view":"front","image":"data:image/jpeg;base64,..."}     (488 KB)

data: {"type":"VIEW_READY","view":"side","image":"data:image/jpeg;base64,..."}      (384 KB)

data: {"type":"VIEW_READY","view":"back","image":"data:image/jpeg;base64,..."}      (441 KB)

data: {"type":"VIEW_READY","view":"sitting","image":"data:image/jpeg;base64,..."}   (493 KB)

data: {"type":"COMPLETE","jobId":"720d57f8-...","colorVariant":{...}}
```
Total 28 s. Note `side` arrived before `back`.

---

## 5. Errors

Errors before the stream opens are plain JSON with the HTTP status. Errors after it opens are an `ERROR` event (section 4.2).

| Status | Body | Cause |
| :--- | :--- | :--- |
| `400` | `{ "success": false, "error": "<what to fix>", "code": "INVALID_COLOR" }` | `color` could not be read. No generation happened, nothing was charged. |
| `400` | `{ "success": false, "error": "clientId and modelId are required." }` | Missing IDs. |
| `400` | `{ "success": false, "error": "The primary garment image (fullDress / flat-lay) is strictly required." }` | No garment picture. |
| `401` | `{ "success": false, "error": "Unauthorized: Invalid or missing Service API Key" }` | Bad key. |
| `404` | `{ "success": false, "error": "AI Model not found" }` | Unknown `modelId`. |
| `429` | `{ "success": false, "error": "...", "retryAfterSec": n }` + `Retry-After` header | Over the hourly budget or all generation slots busy. Wait and retry. |
| `500` | `{ "success": false, "error": "Generation failed", "details": "..." }` | Failure before the stream opened. |

`INVALID_COLOR` messages say exactly what to send:

| You sent | Message |
| :--- | :--- |
| `"#12"` | `color "#12" is not a valid hex code. Use #RRGGBB, for example "#0F5132".` |
| `{ "hex": "zzz" }` | `color.hex "zzz" is not a valid hex code. Use #RRGGBB, for example "#0F5132".` |
| `{ "name": "x<script>" }` | `color.name may contain only letters, spaces, hyphens and apostrophes, for example "Bottle Green" or "Off-White".` |
| `{ "border": true }` (no name or hex) | `color needs a name or a hex code: { "name": "Bottle Green", "hex": "#0F5132" }.` |
| `["red"]` | `color must be a colour name ("Bottle Green"), a hex code ("#0F5132"), or an object { "name", "hex", "border", "blouse" }.` |
| a 61-character name | `color.name is too long (61 characters; the most is 60).` |

`""`, `null` and `{}` mean "no colour" and are not errors.

---

## 6. What to expect, honestly

- **The colour is close, not exact.** An image model cannot hit a hex value. `#2745A8` gives *a* royal blue that differs a little between runs. Every response says `colorAccuracy: "approximate"`. Show "Royal Blue" on the product page and keep the hex for your own records. Do not present the picture as "exactly #2745A8".
- **Names beat hex codes.** "Royal Blue" steers the model far better than `#2745A8`. When you have a name, send it.
- **One colour per request.** The gateway closes a request at 90 s; three colours in one request would time out. Loop, one request per colour, a different `clientId` each.
- **A visible blouse in the garment picture** keeps its colour by default. If your product picture is a worn photo with a blouse you do *not* sell, either send your own `blouse` picture or set `"blouse": true`.
- **Multi-colour garments.** Only the base fabric changes. A contrast border, a contrast pallu panel or multi-colour motifs keep their colours. Use `border: true` for a border that should follow.
- **Categories.** All five women's categories take `color`. Sarees have been verified in real runs (section 7); lehenga, anarkali, sharara and kurti go through the same code and offline checks but have not yet had a real run. The men's catalog does not read `color`.
- **Without `color` nothing changes.** The prompts for a request with no colour are byte-for-byte the ones used before this feature, checked by a pinned fingerprint in the test suite.

---

## 7. Verified results

| Date | Input | Colour asked | Result |
| :--- | :--- | :--- | :--- |
| 24 Sep 2026 | Green-and-gold silk saree, worn photo with a maroon blouse, `saree2` | Royal Blue `#2745A8` | 4 views in 107 s. Body an even royal blue in every fold; gold zari stayed gold; motifs kept size and layout; three views matched the front; plain studio in all four. **Fault:** the maroon blouse and the border's maroon selvedge came out blue. The prompt was strengthened to name the forbidden outcome. |
| 24 Sep 2026 | Red Banarasi, gold brocade blouse, gold border, `saree1` (after the fix) | Emerald Green `#0B6E4F` | 4 views in 28 s. Saree an even emerald green; **blouse stayed red-and-gold brocade; border and zari stayed gold**; diamond and paisley motifs unchanged; model, pose and background unchanged. |
| 24 Sep 2026 | Whole pipeline against a stand-in for the image model, 25 checks, free | various | Bad colour → `400 INVALID_COLOR` before any call; 4 calls with `color`, the colour rule only in the front call, the pinned background in all four; 0 changes without `color`; aliases and switches; 5-call fallback mode. |

Unit suite: 511 checks pass, including the byte-identical fingerprint for requests without `color`.

---

## 8. Example client (JavaScript)

```js
const BASE = 'https://api-super-admin.onrender.com/api/gateway/cat';

async function catalogInColour({ clientId, modelId, garmentUrl, colour, category = 'SAREE' }) {
  const res = await fetch(`${BASE}/api/v1/draping/generate-catalog/women`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.API_KEY },
    body: JSON.stringify({ clientId, modelId, category, saree: garmentUrl, color: colour })
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);   // 400 INVALID_COLOR lands here

  const views = {};
  let variant = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n'); buffer = frames.pop();
    for (const frame of frames) {
      if (!frame.startsWith('data: ')) continue;                       // skips keepalive comments
      const event = JSON.parse(frame.slice(6));
      if (event.type === 'COLOR_VARIANT') variant = event;
      if (event.type === 'VIEW_READY') views[event.view] = event.image; // key by view, not by order
      if (event.type === 'ERROR') throw new Error(event.error);
      if (event.type === 'COMPLETE') return { jobId: event.jobId, variant: event.colorVariant || variant, views };
    }
  }
  throw new Error('stream ended without COMPLETE');
}

// three colours of one product, one request each
for (const [key, colour] of [['red', '#C8102E'], ['green', '#0B6E4F'], ['blue', '#2745A8']]) {
  const out = await catalogInColour({ clientId: `sku-991-${key}`, modelId: 'saree2', garmentUrl: 'https://cdn.shop/sku-991.jpg', colour });
  console.log(out.variant.colorName, Object.keys(out.views));        // e.g. "Royal Blue" [ 'front', 'side', 'back', 'sitting' ]
}
```

Retry once on a gateway `5xx`; the request is safe to repeat because nothing is stored server-side (images are never saved).

---

## 9. Quick reference

```
POST /api/v1/draping/generate-catalog/women
  x-api-key: <key>

  { clientId, modelId, saree|full|fullDress, [blouse|top|topFront], [bottom], [category],
    color: "Royal Blue" | "#2745A8" | { name, hex, border?, blouse? } }

  -> text/event-stream
     STATUS -> COLOR_VARIANT -> VIEW_READY x4 (front first) -> COMPLETE { jobId, colorVariant }
     or ERROR
  -> 400 INVALID_COLOR (JSON) when color cannot be read; nothing generated

  4 image calls, 28-110 s, colour approximate, same plain studio for every colour of a product
```
