# ScaleEasy Catalog Service — API Documentation

One service exposing two independent capabilities:

| Capability | Path | Shape |
| :--- | :--- | :--- |
| **Catalog Try-On** | `/api/v1/draping/*` | Long-running, streams over SSE |
| **Design Discovery** | `/api/v1/discovery/*` | Fast, plain JSON |

They share a host, an API key and a gateway slug, but nothing else — a failure in one does not
affect the other.

> Everything in this document was verified against the running service. Where behaviour is
> surprising (a field that is accepted but ignored, a category that is silently rewritten) it is
> documented as it actually behaves, not as it ideally would.

---

## 🚀 Base URL

**Production (via gateway):** `https://api-super-admin.onrender.com/api/gateway/cat`
**Direct / local:** `http://localhost:4005`

The gateway strips the `cat` segment and forwards the rest of the path unchanged, so
`/api/gateway/cat/api/v1/discovery/search` reaches the service as `/api/v1/discovery/search`.

## 🔒 Authentication

| Header | Value |
| :--- | :--- |
| `x-api-key` | Your API key |
| `Content-Type` | `application/json` |

Every path under `/api/` requires the key. **`GET /health` is the only exception** — it is
deliberately unauthenticated so load balancers and the gateway's health cron can reach it.

A missing or wrong key returns `401`:

```json
{ "success": false, "error": "Unauthorized: Invalid or missing Service API Key" }
```

---

# 📡 Catalog Try-On


### Two pipelines behind one path — women and men

`/generate-catalog` dispatches to one of two pipelines. **`category` is interpreted, not demanded**,
so existing integrations keep working unchanged:

| `category` you send | Goes to | Garment type used |
| :--- | :--- | :--- |
| `"women"` | women pipeline | `garmentCategory`, or `SAREE` |
| `"men"` | men pipeline | `garmentCategory`, or `FORMALS` |
| `SAREE`, `LEHANGA`, `ANARKALI`, `SHARARA`, `KURTHI` | women pipeline | the value itself |
| `FORMALS`, `BLAZER`, `KURTA_PAJAMA`, `SHERWANI` | men pipeline | the value itself |
| anything else, or omitted | women pipeline | the value itself (`SAREE` if absent) |

So both of these are valid and equivalent:

```json
{ "clientId": "acme", "modelId": "saree1", "category": "SAREE", "saree": "..." }
{ "clientId": "acme", "modelId": "saree1", "category": "women", "garmentCategory": "SAREE", "saree": "..." }
```

The women pipeline is documented in full below. **The men pipeline is newer and was not verified by
the same end-to-end testing** — treat the section at the end of this document as a description of
its code rather than of proven behaviour.

## `POST /api/v1/draping/generate-catalog`

Takes one or more garment images and streams back a 4-view catalog — front, back, side and
sitting — generated onto a chosen AI model.

### Request payload

| Field | Type | Required | Notes |
| :--- | :--- | :--- | :--- |
| `clientId` | String | **Yes** | Your tenant identifier. Also the zombie-job key — see below. |
| `modelId` | String | **Yes** | One of the 22 IDs listed below. |
| `saree` / `full` / `fullDress` | String | **Yes** | The primary garment. First non-empty of these three wins, in that order. |
| `blouse` / `top` / `topFront` | String | No | The top or blouse. Same precedence order. |
| `bottom` | String | No | Skirt or pants. |
| `category` | String | No | Defaults to `SAREE`. See *Category handling*. |
| `dupattaStyleUrl` | String | No | **LEHANGA only.** See *Dupatta style*. |
| `topBack` | String | No | **Accepted but ignored** — see below. |

#### ⚠️ `topBack` is accepted and silently discarded

The route reads `topBack` from the body and forwards it, but the generation service never
consumes it. Sending it causes no error and has **no effect whatsoever**. It is documented here
only so nobody builds against it expecting it to work.

#### Garment inputs accept three interchangeable forms

Any garment field takes any of these, and they may be mixed within one request:

| Form | Example |
| :--- | :--- |
| **Public image URL** | `"https://cdn.shop/saree-123.jpg"` — fetched server-side |
| **Raw base64** | `"/9j/4AAQSkZJRgABA..."` |
| **data: URI** | `"data:image/jpeg;base64,/9j/4AAQSkZJRgABA..."` |

All three were verified end-to-end and produce identical output. A URL is the lighter option —
it keeps the request body small and lets the service fetch the bytes itself, which is what makes a
Design Discovery result usable directly: pass `fetchable.url` straight through as the garment.

#### Category handling

`category` is upper-cased, then resolved through an alias table before selecting the prompt:

| You send | Resolves to |
| :--- | :--- |
| `SAREE`, `sari` | `SAREE` |
| `KURTI`, `KURTA`, `KURTHI` | `KURTHI` |
| `LEHENGA`, `GHAGRA`, `LEHANGA` | `LEHANGA` |
| `SHARARA`, `GHARARA` | `SHARARA` |
| `ANARKALI` | `ANARKALI` |

Anything unrecognised is **not rejected** — the request still generates, using a generic prompt,
and the server logs a warning. Omitting `category` entirely defaults to `SAREE`.

#### Dupatta style — `LEHANGA` only

`dupattaStyleUrl` is ignored unless the resolved category is `LEHANGA`. It accepts either a
shorthand key or a full image URL:

| Key | Effect |
| :--- | :--- |
| `lehanga_duppatta1` | Adds a dupatta-drape reference **and** swaps the model's front base pose for a single-pleated variant (only for `modelId` `lehanga1`–`lehanga4`) |
| `lehangaduppatta2` | Adds the dupatta-drape reference only — no base-pose swap |
| any `https://…` URL | Used directly as the drape reference |

The reference controls **only how the dupatta is draped** — not its colour, fabric or embroidery,
which come from the garment reference.

### Available `modelId` values — 22 in the database

* **Sarees:** `saree1` `saree2` `saree3` `saree4`
* **Kurtis:** `kurti1` `kurti2` `kurti3` `kurti4`
* **Anarkalis:** `anarkali1` `anarkali2` `anarkali3` `anarkali4`
* **Lehangas:** `lehanga1` `lehanga2` `lehanga3` `lehanga4`
* **Shararas:** `sharara1` `sharara2` `sharara3` `sharara4`
* **Lehenga drape variants:** `lehenga_single_shoulder` `lehenga_traditional_front_pleat`

Note the spelling: model IDs use `kurti` and `lehanga`. An unknown `modelId` returns `404`.

### Example requests

Saree, garment supplied as a URL:

```json
{
  "clientId": "acme-retail",
  "modelId": "saree1",
  "category": "SAREE",
  "saree": "https://cdn.shop/red-silk-saree.jpg",
  "blouse": "https://cdn.shop/matching-blouse.jpg"
}
```

Lehenga with a dupatta drape style, garment as base64:

```json
{
  "clientId": "acme-retail",
  "modelId": "lehanga2",
  "category": "LEHANGA",
  "full": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA...",
  "dupattaStyleUrl": "lehanga_duppatta1"
}
```

---

## 📥 Response — Server-Sent Events

Generation takes roughly **30–70 seconds** for all four views, so this endpoint does not return a
single JSON body. It streams `text/event-stream`.

Chunks are separated by `\n\n`. Frames carrying data are prefixed `data: ` and contain JSON.

### Two things every consumer must handle

**1. Keepalive comment lines.** Between views the server emits SSE comments so proxies do not idle
the connection out:

```
: keepalive 1757000000000
```

They start with `:`, not `data: `. Skip any chunk not prefixed `data: ` — which the SSE spec
requires anyway.

**2. Views arrive out of order.** `front` is always first, because the other three use it as their
consistency reference. `back`, `side` and `sitting` are then generated **concurrently** and
complete in whatever order the model returns them. Key your state off `event.view`, never off
arrival position.

### Event types

**`STATUS`** — a step has started.
```json
{ "type": "STATUS", "message": "Starting AI Generation Pipeline..." }
```

**`VIEW_READY`** — emitted the moment a view finishes. Carries the image as a base64 data URI.
```json
{
  "type": "VIEW_READY",
  "view": "front",
  "image": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA..."
}
```
`view` is one of `front`, `back`, `side`, `sitting`. Verified output: JPEG, roughly 830×1260 to
895×1200, 370–540 KB per view.

**`COMPLETE`** — all four views done.
```json
{ "type": "COMPLETE", "jobId": "a1b2c3d4-..." }
```

**`ERROR`** — generation failed *after* the stream opened. The stream then closes.
```json
{ "type": "ERROR", "error": "Gemini API Error: HTTP 500 - ..." }
```

### Error responses

Failures **before** the stream opens are ordinary JSON. Failures **after** it opens arrive as an
`ERROR` event, because the status code has already been sent.

| Status | Body | When |
| :--- | :--- | :--- |
| `400` | `"clientId and modelId are required."` | Either is missing |
| `400` | `"The primary garment image (fullDress / flat-lay) is strictly required."` | No `saree`/`full`/`fullDress` |
| `401` | `"Unauthorized: Invalid or missing Service API Key"` | Bad or absent key |
| `404` | `"AI Model not found"` | `modelId` is not in the database |
| `429` | `"Service at capacity. Please retry shortly."` | Concurrency limit reached; body includes `activeGenerations` and `maxConcurrent` |
| `500` | `"Generation failed"` + `details` | Failure before streaming began |
| SSE `ERROR` | `error` message | Failure after streaming began |

Validation runs in that order, so a request missing several things reports the first problem only.

### Concurrency and the zombie killer

**Admission control.** The service accepts a limited number of simultaneous generations
(`MAX_CONCURRENT_GENERATIONS`, default 3). Beyond that it returns `429` immediately rather than
queueing — a fast honest answer instead of a request that starves. Retry shortly.

**Zombie killer.** Starting a new generation with a `clientId` that already has one running
**aborts the old one**. This exists so a user refreshing the page does not leave orphaned work
burning GPU time. If you run genuinely parallel jobs, give each a distinct `clientId` — otherwise
they will cancel each other.

---

## 🛑 `POST /api/v1/draping/cancel-job`

Explicitly stops a running generation. Useful because reverse proxies often mask a client
disconnect, so the server may not notice a browser has gone away.

```json
{ "clientId": "acme-retail" }
```

| Status | Body |
| :--- | :--- |
| `200` | `{ "success": true, "message": "Pipeline successfully aborted." }` |
| `200` | `{ "success": false, "message": "No active job running for this client." }` |
| `400` | `{ "success": false, "error": "clientId required" }` |

Note both outcomes are `200` — `success` distinguishes them.

---

## 💻 Example implementation

```js
const res = await fetch(`${BASE}/api/v1/draping/generate-catalog`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  body: JSON.stringify({
    clientId: 'acme-retail',
    modelId: 'saree1',
    category: 'SAREE',
    saree: garmentUrlOrBase64
  })
});

if (!res.ok) throw new Error((await res.json()).error);

const reader = res.body.getReader();
const decoder = new TextDecoder();
const views = {};
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const chunks = buffer.split('\n\n');
  buffer = chunks.pop();                       // keep the incomplete tail

  for (const chunk of chunks) {
    if (!chunk.startsWith('data: ')) continue; // skips ": keepalive ..." comments
    const event = JSON.parse(chunk.slice(6));

    if (event.type === 'VIEW_READY') views[event.view] = event.image;  // key by view, NOT order
    if (event.type === 'ERROR')      throw new Error(event.error);
    if (event.type === 'COMPLETE')   console.log('done', event.jobId);
  }
}
```

---

# 🔎 Design Discovery

A separate capability on the same service. It takes keywords — or one line of natural language —
and returns **references** to garment designs found on the web.

> **Browse-only.** Discovery says *"here are designs found on the web"*, not *"here is a design
> licensed and cleared for use"*. It never downloads, stores, transforms or returns image bytes.
> Every result carries `sourceUrl` and `sourceDomain`; **responsibility for rights in any
> downstream use rests with the caller.**

## `POST /api/v1/discovery/search`

### Request payload

| Field | Type | Required | Notes |
| :--- | :--- | :--- | :--- |
| `clientId` | String | **Yes** | Tenant identifier; also the rate-limit bucket. |
| `keywords` | String[] | * | 1–12 terms. |
| `instruction` | String | * | One line of natural language, max 500 chars. |
| `category` | String | * | A garment id or alias — see `GET /taxonomy`. |
| `designType` | String | No | A design area **of that garment**. Requires `category`. |
| `filters.color` / `.fabric` / `.occasion` | String | No | Search qualifiers, not guarantees. |
| `shotType` | String | No | `flatlay`, `worn`, or `any` (default). |
| `page` | Number | No | 1–20, default 1. |
| `limit` | Number | No | 1–50, default 20. |

\* **At least one of `keywords`, `category` or `instruction` is required.** They combine freely:
explicit fields always win, and `instruction` only fills the gaps they leave.

**Taxonomy.** The service knows **12 garments and 107 design areas** — fetch the tree from
`GET /api/v1/discovery/taxonomy`. A design area is validated against its garment, so `SAREE` +
`PALLU` is accepted while `SAREE` + `SLEEVE` returns `400` listing what is valid.

Canonical ids match the generation service's spelling, so one id means one garment platform-wide:
`LEHANGA` (displayed *Lehenga*) and `KURTHI` (displayed *Kurti*). `LEHENGA` and `KURTI` are
accepted as aliases and canonicalised — the `interpreted` block shows what you resolved to.

**Natural language.** Send a sentence instead of structured fields and it is resolved
deterministically against the taxonomy — no LLM, no added latency:

```json
{ "clientId": "acme", "instruction": "I want red bridal kanjivaram saree pallu designs with heavy zari" }
```
resolves to category `SAREE`, designType `PALLU`, keywords `["red","bridal","kanjivaram","heavy zari"]`.

You may also pin a category alongside an instruction — the design area is then resolved *within*
that garment even if the sentence never names it.

**`shotType`.** A bare `"red bridal saree"` search returns mostly on-model editorial photos.
`flatlay` biases toward flat product photography; measured at 92% garment-only against 10% for
`any`.

### Response

```jsonc
{
  "success": true,
  "searchId": "b1f2c3d4-...",
  "query": "red bridal kanjivaram saree pallu closeup design",
  "cached": false,
  "interpreted": {
    "category": "SAREE", "categoryName": "Saree",
    "designType": "PALLU", "designTypeName": "Pallu Design",
    "keywords": ["red", "bridal", "kanjivaram"],
    "source": "instruction",       // instruction | structured | mixed
    "confidence": "high",
    "unresolved": []
  },
  "results": [
    {
      "id": "result_9f2a1c7b4e10",
      "position": 1,
      "title": "Red Bridal Kanjivaram Saree",
      "imageUrl": "https://example.com/images/saree-123.jpg",
      "thumbnailUrl": "https://encrypted-tbn0.gstatic.com/...",
      "thumbnailWidth": 190,
      "thumbnailHeight": 253,
      "sourceUrl": "https://example.com/product/123",
      "sourceDomain": "example.com",
      "width": 1200,
      "height": 1600,
      "imageUsable": true,
      "fetchable": {
        "url": "https://example.com/images/saree-123.jpg",
        "width": 1200, "height": 1600,
        "from": "imageUrl"
      }
    }
  ],
  "pagination": { "page": 1, "limit": 20, "hasMore": true }
}
```

Two fields that mean less than they may appear to:

- **`searchId` is a correlation id for logs only.** There is no database, so nothing can be fetched
  by it later.
- **`hasMore` is inferred, not authoritative.** The upstream provider reports no total count, so a
  full page is the only available signal.

`id` is a stable hash of `imageUrl`, so the same design keeps the same id across repeated searches.

### `fetchable` — the only field most consumers need

Two different truths live in every result:

| | Meaning |
| :--- | :--- |
| `imageUrl`, `width`, `height` | What the **source claims the original is** — whether or not it can be retrieved |
| `fetchable.url`, `.width`, `.height` | What you can **actually retrieve**, and its true size |

**If you only read `fetchable`, you are correct in every case** — no branching, and no knowledge of
Instagram, Facebook or `imageUsable` required:

```js
const res = await fetch(result.fetchable.url);   // always an image
store({ width: result.fetchable.width, height: result.fetchable.height });
```

Worked example — an Instagram result. Note the ~3× gap, and that `width`/`height` are **not**
rewritten: the original post genuinely is 1440×1920, which is legitimate provenance.

```jsonc
{
  "imageUrl": "https://lookaside.instagram.com/...",   // serves HTML, do not fetch
  "width": 1440, "height": 1920,                       // the original post
  "thumbnailUrl": "https://encrypted-tbn0.gstatic.com/...",
  "thumbnailWidth": 387, "thumbnailHeight": 516,
  "imageUsable": false,
  "fetchable": { "url": "https://encrypted-tbn0.gstatic.com/...",
                 "width": 387, "height": 516, "from": "thumbnailUrl" }
}
```

> **`fetchable.url` is point-in-time, not permanent.** It is the URL Discovery selected as the
> retrievable image asset, based on its image-capability checks **at the time of the search**. CDN
> URLs, signed URLs and social thumbnails expire and rotate. If you intend to keep a design,
> retrieve it promptly and store your own copy — do not treat our URL as durable storage.

### Sources, and what each can give you

Results come from the open web **and** from social platforms. They are not equally usable:

| Source | `imageUrl` | `thumbnailUrl` | `imageUsable` |
| :--- | :--- | :--- | :--- |
| Retailers, blogs, **Pinterest** (`i.pinimg.com`) | a real image | a real image | `true` |
| **Instagram** (`lookaside.instagram.com`) | an HTML page | a real image | `false` |
| **Facebook** (`lookaside.fbsbx.com`) | an HTML page | a real image | `false` |

**Instagram and Facebook designs are only ever available at ~400px** — measured sizes 335×597,
387×516, 447×447. Their `imageUrl` serves HTML and the thumbnail is all that can be retrieved.
There is no workaround. If you are feeding these to a generation model, treat them as weak inputs.

There is no `sources` parameter and none is needed: Pinterest and Instagram surface naturally in
untargeted searches, and including a platform name as an ordinary keyword biases heavily toward it.
(`site:` operators return zero results from this provider and are not used.)

Results are filtered before return: entries without an image URL are dropped, duplicates by image
URL are collapsed, images the provider reports as smaller than 400×400 are discarded, and anything
with neither a usable `imageUrl` nor a thumbnail is removed. Results with an unreported size are kept.

## `GET /api/v1/discovery/taxonomy`

The full garment → design-area tree, so a Manage Designs UI renders from the service rather than
hardcoding 107 entries. No payload.

```jsonc
{
  "success": true,
  "garmentCount": 12,
  "designAreaCount": 107,
  "garments": [
    { "id": "SAREE", "name": "Saree",
      "designTypes": [ { "id": "PALLU", "name": "Pallu Design" } ] }
  ]
}
```

Garments: `SAREE` `BLOUSE` `DUPATTA` `KURTHI` `ANARKALI` `PETTICOAT` `GOWN` `SUIT` `SHERWANI`
`BOTTOM_WEAR` `LEHANGA` `SHARARA`.

## `GET /api/v1/discovery/categories`

Garment ids, shot types and request limits. No payload.

```json
{
  "success": true,
  "categories": ["SAREE", "BLOUSE", "DUPATTA", "KURTHI", "ANARKALI", "PETTICOAT",
                 "GOWN", "SUIT", "SHERWANI", "BOTTOM_WEAR", "LEHANGA", "SHARARA"],
  "shotTypes": ["flatlay", "worn", "any"],
  "limits": { "maxLimit": 50, "maxPage": 20 }
}
```

## ⚠️ Discovery error codes

| Status | `error.code` | Meaning |
| :--- | :--- | :--- |
| `400` | `VALIDATION_ERROR` | Bad body — also covers unknown `category`, a `designType` that is not an area of its garment, `designType` without `category`, an unresolvable instruction, and no search terms at all. `error.details` names the field and lists what is valid. |
| `400` | `INVALID_JSON` | Body was not valid JSON. |
| `401` | — | Missing or wrong `x-api-key`. |
| `413` | `PAYLOAD_TOO_LARGE` | Body exceeded the 32 KB discovery limit. |
| `429` | `RATE_LIMIT_EXCEEDED` | Per-client search budget exhausted. Honour `Retry-After`. |
| `424` | `PROVIDER_UNAVAILABLE` | Upstream search provider failed, timed out or rejected us. |
| `424` | `DISCOVERY_NOT_CONFIGURED` | Discovery is switched off on this deployment. |
| `424` | `TAXONOMY_INVALID` | Taxonomy failed its integrity check; discovery disabled, generation unaffected. |

Errors are shaped `{ "success": false, "error": { "code", "message", "details"? } }`.

**Why `424` and not `503`.** Discovery shares a gateway slug with catalog generation, and the
gateway runs a per-slug circuit breaker that trips on repeated `5xx`. Reporting an upstream outage
as `5xx` would take `generate-catalog` offline as collateral damage, so every anticipated failure —
provider outages included — is reported as `4xx`.

## 🔧 Discovery operational notes

- **Caching.** Identical queries are served from an in-process cache (default TTL 1 hour), so
  repeats do not re-bill the provider. Cached responses set `"cached": true`. Per-process: it
  empties on restart and does not coordinate across instances.
- **Rate limiting.** Default 20 searches/minute per `clientId`, counted whether or not the response
  came from cache. This protects the search-provider budget; the gateway separately enforces its own
  limits.
- **Fails soft.** If the provider key is absent or the taxonomy fails its integrity check, the
  service still boots, logs the reason, and only `/api/v1/discovery/*` returns `424`. **Catalog
  generation is never affected.**

---

## 🛠 Architecture and data policies

* **Zero retention for generation.** Input and output images are never written to the database.
  The API is base64/URL-in, base64-out; only job metadata is stored for billing and auditing.
* **Discovery stores nothing at all** — no images, no results, no search history.
* **Independent failure.** Discovery reports every anticipated failure as `4xx` specifically so it
  cannot trip the shared circuit breaker and take generation down, and vice versa.
* **Generation is capped, not queued.** Excess concurrent load is rejected with `429`.

### Environment variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `DATABASE_URL` | — | Required. Postgres, `se_catalog` schema. |
| `GEMINI_API_KEY` | — | Required. |
| `SERVICE_API_KEY` | — | Required. Must match the gateway's stored secret. |
| `SERPER_API_KEY` | — | Optional. Absent disables discovery only. **serper.dev, not serpapi.com.** |
| `GEMINI_TIMEOUT_MS` | `120000` | Ceiling for one Gemini call. |
| `MAX_CONCURRENT_GENERATIONS` | `3` | Excess returns `429`. |
| `SSE_HEARTBEAT_MS` | `15000` | Keepalive interval. |
| `PARALLEL_VIEWS` | `true` | `false` generates the dependent views serially. |
| `INPUT_IMAGE_FORMAT` / `_QUALITY` | `jpeg` / `95` | Upload format for images sent to Gemini. |
| `BASE_MODEL_CACHE_MAX` | `24` | Processed base poses held in memory. |
| `SHUTDOWN_GRACE_MS` | `30000` | Forced exit if in-flight work will not drain. |
| `DISCOVERY_CACHE_TTL_SEC` | `3600` | Search cache lifetime. |
| `DISCOVERY_RATE_LIMIT_PER_MIN` | `20` | Searches per minute per `clientId`. |


---

# 👔 Men's Catalog — `/api/v1/draping/*`

Added alongside the women pipeline and reached through the same dispatcher. **Not covered by the
end-to-end verification behind the rest of this document**; the following is derived from the code.

### `POST /generate-catalog` with `category: "men"`

| Field | Type | Required | Notes |
| :--- | :--- | :--- | :--- |
| `clientId` | String | **Yes** | |
| `category` | String | **Yes** | `"men"`, or a men's garment type directly |
| `garmentCategory` | String | No | `FORMALS` (default), `BLAZER`, `KURTA_PAJAMA`, `SHERWANI` |
| `full` | String | * | The garment image |
| `topFront` / `tops` / `bottom` | String | * | Individual pieces |
| `userPhoto` | String | No | Used by the try-on and size flows |

\* At least one garment image is required — otherwise `"Garment image is required."`

### Additional men-only endpoints

| Endpoint | Purpose |
| :--- | :--- |
| `POST /api/v1/draping/recommend-size` | Analyses a user photo and recommends a size. Requires a non-empty `sizes` array. |
| `POST /api/v1/draping/generate-top-wear` | Generates top-wear only |
| `POST /api/v1/draping/generate-bottom-wear` | Generates bottom-wear only |
| `POST /api/v1/draping/generate-user-tryon` | Try-on against a supplied user photo |
| `POST /api/v1/draping/cancel-job` with `pipeline: "men"` | Cancels a men job |

### Cancelling a men job

The dispatcher routes `cancel-job` by an explicit `pipeline` field first:

```json
{ "clientId": "your-id", "pipeline": "men" }
```

Without it, only the bundled men frontend's `clientId` (`men-frontend`) is recognised; everything
else falls back to the women pipeline. **If you use an arbitrary `clientId` for men jobs, send
`pipeline` explicitly** or your cancel will be routed to the wrong pipeline and silently do nothing.

### Known gap

The men generation service carries its own copy of the Gemini call logic. The reliability fixes
applied to the women pipeline — retrying the response body read, a per-call timeout, base-pose
caching, parallel view generation and JPEG uploads — **have not been ported to it**. It is expected
to be slower and more failure-prone until that is done.
