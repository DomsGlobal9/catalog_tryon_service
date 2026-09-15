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

### Gateway limits that apply to every call

| Limit | Value | Why it matters |
| :--- | :--- | :--- |
| Request timeout | **90 s** | Generation takes 30–70 s. At the previous 30 s setting, slower generations were cut off mid-stream. |
| Max payload | **50 MB** | Matches the service's own body limit, so a base64 image accepted by one is accepted by the other. |

These are gateway-side settings, not service settings — a direct call to the service is not subject
to them. Verified against production: a generation completing in **31.7 s** streamed to completion
through the gateway, which the old 30 s limit would have killed.

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


### Three capabilities, three endpoints

Each capability has its own endpoint:

| Endpoint | Capability |
| :--- | :--- |
| `POST /api/v1/draping/generate-catalog/women` | Women's catalog — 4 views |
| `POST /api/v1/draping/generate-catalog/men` | Men's catalog — one image per size |
| `POST /api/v1/discovery/search` | Design discovery |

`POST /api/v1/draping/generate-catalog` (no suffix) remains as a **backward-compatible dispatcher**
for callers written before the split. **`category` is interpreted, not demanded**, so existing
integrations keep working unchanged:

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

The women pipeline is documented in full below; the men pipeline has its own section at the end.
Both have now been exercised end-to-end against production — see the verification note at the
bottom of this document for exactly what was run.

## `POST /api/v1/draping/generate-catalog`

Takes one or more garment images and streams back a 4-view catalog — front, back, side and
sitting — generated onto a chosen AI model.

### Request payload

| Field | Type | Required | Notes |
| :--- | :--- | :--- | :--- |
| `clientId` | String | **Yes** | Your identifier for the user or session. Also the zombie-job key — see below. |
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
| `429` | `"Service at capacity. Please retry shortly."` | Too many generations running right now; body includes `retryAfterSec`, `activeGenerations` and `maxConcurrent` |
| `429` | `"Generation limit reached: N per hour. Retry in Ns."` | Your account's hourly generation allowance is used up; body includes `retryAfterSec` |
| `500` | `"Generation failed"` + `details` | Failure before streaming began |
| SSE `ERROR` | `error` message | Failure after streaming began |

Validation runs in that order, so a request missing several things reports the first problem only.

### Concurrency and the zombie killer

**Admission control.** When the service is busy, or your account has used its hourly generation
allowance, it returns `429` immediately rather than queueing — a fast honest answer instead of a
request that starves. Every `429` carries a `Retry-After` header (seconds) and the same value as
`retryAfterSec` in the body; wait that long before retrying. A request refused because the service
was busy does not count against your allowance.

**Zombie killer.** Starting a new generation with a `clientId` that already has one running
**aborts the old one**. This exists so a user refreshing the page does not leave orphaned work
burning GPU time. If you run genuinely parallel jobs, give each a distinct `clientId` — otherwise
they will cancel each other.

**Your jobs are yours.** Jobs are kept apart per API key account. Another customer who happens to use
the same `clientId` can never replace or cancel your job, and you cannot touch theirs.

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

Note both outcomes are `200` — `success` distinguishes them. A cancel only reaches jobs started with
the same API key account and `clientId`, and takes effect within about two seconds; the generation's
stream then ends without a `COMPLETE` event.

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

A separate capability on the same service. It takes keywords — or one line of plain English — and
returns **links to garment design images** found on the web, **Pinterest**, **Instagram** and
**Facebook**.

> **Browse-only.** Discovery never downloads, stores, transforms or returns image bytes. Every result
> carries `sourceUrl` and `sourceDomain`; **responsibility for rights in any downstream use rests with
> the caller.**

> **The complete reference** — every field, the stream event format with a working reader, platform
> behaviour, costs and errors — is [`DISCOVERY_SEARCH_API.md`](./DISCOVERY_SEARCH_API.md). This section
> is a summary; where they differ, that file is authoritative.

## Endpoints

| Endpoint | Purpose |
| :--- | :--- |
| `POST /api/v1/discovery/search` | Search. Waits for every platform, answers once in JSON. |
| `POST /api/v1/discovery/search/stream` | The same search as **Server-Sent Events**: each platform's results as soon as that platform finishes. |
| `GET /api/v1/discovery/taxonomy` | The garment → design-area tree (12 garments, 107 areas). |
| `GET /api/v1/discovery/categories` | Garment ids, sources, recency values, shot types, result-filter shape and limits. |

Both search endpoints take the **same body**:

| Field | Required | Summary |
| :--- | :--- | :--- |
| `clientId` | **Yes** | Your identifier for the user or session, 1–128 chars. Shown in logs. |
| `keywords` / `instruction` / `category` | at least one | What to search for. Explicit fields beat what is parsed from `instruction`. |
| `designType` | No | A design area of `category`, e.g. `SAREE` + `PALLU`. |
| `sources` | No | `web` (default), `pinterest`, `instagram`, `facebook` — up to 4, searched in parallel. |
| `recency` | No | `any` (default), `day`, `week`, `month`, `year`. |
| `resultFilters` | No | Guaranteed: `fullSizeOnly`, `minWidth`, `orientation`, `excludeDomains`. |
| `shotType` | No | `flatlay` / `worn` / `any` — **a hint only**; `flatlay` still returned a person wearing the garment 54% of the time. |
| `filters.color` / `.fabric` / `.occasion` | No | Words added to the search, not verified. |
| `page` / `limit` | No | 1–20 / 1–100 (per platform), defaults 1 / 20. |

A request that sends no `sources` is exactly the single web search that existed before — same query,
same result shape, with some additive fields.

## What each result tells you

Every result has `platform` (the site it is from), `foundBy` (the platform search that found it) and
`fetchable` — **the URL to actually retrieve, and its size**. Read `fetchable` and you never need to
branch on platform:

- Instagram and Facebook only allow a **small preview** (`fetchable.from: "thumbnailUrl"`, ~330–480 px).
- Pinterest images indexed at 236/474 px are **upgraded to the 736 px file**; their size is an estimate
  (`fetchable.sizeExact: false`) and the original is kept as `fetchable.fallbackUrl`.
- `fetchable.url` is point-in-time — retrieve and store your own copy if you intend to keep a design.

The JSON response also has `sources[]`: per platform, the exact query sent, `status`, time taken, and
how many results were returned, were duplicates, came from other sites, or were removed by your filters.

## Behaviour that matters in production

- **One failing platform does not fail the search.** `/search` still answers `200` and reports the
  failure in `sources[]`; only when every platform fails does it return `424`. The stream reports it in
  that platform's event and ends with `done.status` of `partial` or `failed`.
- **Requests are refused before a stream opens** — invalid body, bad key, over the rate limit or
  switched off are normal JSON `400/401/413/424/429`. Only `200 text/event-stream` is a stream.
- **Cost:** each platform is one search-provider call (1 credit for 10 results, 2 credits for 20, 50 or
  100).
- **Rate limit:** 20 provider calls per minute per API key account — changing `clientId` does not reset
  it. A four-platform search counts 4; a search
  answered from cache — including the same search with different `resultFilters` — counts 0. A refused
  request uses none of the budget and carries `Retry-After`.
- **Caching:** identical searches are cached for 1 hour in-process, and identical searches arriving at
  the same moment share one provider call. The cache empties on restart and is not shared between
  instances.
- **Busy moments:** at most 10 provider calls run at once per instance; extra calls wait their turn
  (up to 20 s) instead of being refused by the provider. A provider "too many requests" or 5xx is
  retried twice with a short wait; timeouts and credential errors are not. Measured: 48 simultaneous
  calls all succeeded, where 32 without the queue lost 7. Under load a platform simply arrives later.
- **No `5xx` for anticipated failures.** Discovery shares a gateway route with catalog generation, and
  that gateway trips a circuit breaker on repeated `5xx`; a provider outage is therefore `424`.
- **Fails soft.** Without a provider key, or if the taxonomy fails its integrity check, the service still
  boots and only `/api/v1/discovery/*` returns `424` (`DISCOVERY_NOT_CONFIGURED` / `TAXONOMY_INVALID`).
  Catalog generation is never affected.

---

## 🛠 Architecture and data policies

* **Zero retention for generation.** Input and output images are never written to the database.
  The API is base64/URL-in, base64-out; only job metadata is stored for billing and auditing.
* **Discovery stores nothing at all** — no images, no results, no search history.
* **Independent failure.** Discovery reports every anticipated failure as `4xx` specifically so it
  cannot trip the shared circuit breaker and take generation down, and vice versa.
* **Generation is capped, not queued.** Excess load is rejected with `429` and a `Retry-After` header.

### Request size limits

Body size limits differ by capability: discovery parses at **32 KB** (it only ever receives
keywords), while the catalog endpoints parse at **50 MB** (they receive base64 images). Discovery is
mounted before the larger parser so its own limit applies.


---

# 👔 Men's Catalog

Reached at its own endpoint. **Its request and response contract differs from the women pipeline** —
it is size-driven, not view-driven, so do not assume the two are interchangeable.

## `POST /api/v1/draping/generate-catalog/men`

| Field | Type | Required | Notes |
| :--- | :--- | :--- | :--- |
| `full` / `topFront` / `bottom` | String | **Yes** | At least one garment image. URL, raw base64 or data URI. |
| `sizes` | String[] | **Yes** | Non-empty. Values are upper-cased and trimmed, then checked against `sizeType`. |
| `clientId` | String | No | Defaults to `"men-frontend"`. Also the cancel/zombie key — give each parallel job its own. The same `429` responses as the women pipeline apply (busy, or hourly allowance used), each with `Retry-After`. |
| `category` | String | No | `FORMALS`, `BLAZER`, `KURTA_PAJAMA`, `SHERWANI`. No default is applied here. |
| `categoryGroup` | String | No | `TOP_WEAR` (default) or `BOTTOM_WEAR`. **Note the underscore.** |
| `sizeType` | String | No | `"standard"` (default) or `"waist"`. Anything else is rejected. |
| `tops` | String[] | No | Mix-and-match: several tops against one bottom. |
| `userPhoto` | String | No | Switches the pipeline into try-on mode. |

> **There is no `validatedSizes` request field.** An earlier version of this document listed one.
> It is an internal variable the route derives from `sizes`; sending it does nothing.

**Allowed size values**

| `sizeType` | Accepted `sizes` |
| :--- | :--- |
| `standard` | `S` `M` `L` `XL` `XXL` `XXXL` |
| `waist` | `28` `30` `32` `34` `36` `38` `40` |

A verified minimal request — this is exactly what was run against production:

```json
{
  "clientId": "acme-retail",
  "category": "SHERWANI",
  "categoryGroup": "TOP_WEAR",
  "full": "https://cdn.shop/sherwani-flatlay.jpg",
  "sizes": ["M"]
}
```

### Response — SSE, but different events from the women pipeline

The men pipeline generates **one image per requested size**, not four views. Its events are:

| Event | Meaning |
| :--- | :--- |
| `STATUS` | Step description (shared with the women pipeline) |
| `SIZE_STATUS` | `{ size, status }` — a size has started generating |
| `SIZE_READY` | `{ size, result }` — `result` is a `data:image/jpeg;base64,...` URI |
| `COMPLETE` | All sizes done |
| `ERROR` | Failed after the stream opened |

A consumer written against the women pipeline's `VIEW_READY` will receive **nothing** here. Handle
`SIZE_READY` and key by `size`.

#### The two pipelines use different field names

This trips people up, so it is worth stating plainly:

| | Garment field in | Image field out |
| :--- | :--- | :--- |
| **Women** | `saree` / `full` / `fullDress` | `image` |
| **Men** | `full` / `topFront` / `bottom` | `result` |

Reading only `image` will silently miss every men result, and vice versa. If you consume both,
read `event.result || event.image`.

**Exactly one `SIZE_READY` per size.** Until September 2026 this event was emitted **twice** for
every size — once from the streaming callback and once again afterwards, carrying byte-identical
payloads. Consumers that keyed by `size` never noticed; consumers that appended to a list received
every image twice. Fixed: the second emit is now a fallback that fires only if the first did not.

### Men-specific validation errors

| Status | Body | When |
| :--- | :--- | :--- |
| `400` | `"Garment image is required."` | None of `full`, `topFront`, `bottom` supplied |
| `400` | `"sizes array is required and cannot be empty."` | `sizes` missing or `[]` |
| `400` | `"Invalid size. Allowed sizes are S, M, L, XL, XXL and XXXL."` | `sizeType: "standard"` with an unlisted size |
| `400` | `"Invalid waist size. Allowed sizes are 28, 30, 32, 34, 36, 38, 40."` | `sizeType: "waist"` with an unlisted size |
| `400` | `"Invalid sizeType."` | `sizeType` is neither `standard` nor `waist` |
| `400` | `"User photo is required for size recommendation."` | `recommend-size` without `userPhoto` |

Verified: a `SHERWANI` request with `sizes: ["M"]` and a flat-lay URL streamed `STATUS` →
`SIZE_STATUS` → `SIZE_READY` carrying a 476 KB base64 JPEG → `COMPLETE`, in 12.2 s.

To be precise about what was tested where: the **production** run was made before the duplicate fix
and returned two identical `SIZE_READY` events. The single-event behaviour was verified against a
local build carrying the fix. Production picks it up on its next deploy of that commit.

## Men-only endpoints

| Endpoint | Purpose |
| :--- | :--- |
| `POST /api/v1/draping/recommend-size` | Analyses a user photo and recommends a size |
| `POST /api/v1/draping/generate-top-wear` | Top-wear only |
| `POST /api/v1/draping/generate-bottom-wear` | Bottom-wear only |
| `POST /api/v1/draping/generate-user-tryon` | Try-on against a supplied user photo |
| `POST /api/v1/draping/cancel-job/men` | Cancels a men job |

## Reliability and performance

The men service previously carried its own unfixed copy of the Gemini call logic. It now has the
same treatment as the women pipeline:

- the response body is read **inside** the retry loop, so a mid-download connection reset retries
  instead of killing the job
- a wall-clock ceiling on every upstream call, combined with the client abort signal
- processed base poses cached in memory rather than re-fetched per request
- reference images prepared concurrently instead of in series
- JPEG q95 uploads rather than PNG

It also fixes a latent defect: every outgoing image part declared the **caller's** mime type while
sending **resized** bytes, so the declaration never matched the payload. All five now declare the
format actually produced.

---

# ✅ What was verified, and how

This document is written from observed behaviour. Everything below was run against **production
through the gateway** (`https://api-super-admin.onrender.com/api/gateway/cat`) on 4 September 2026,
using a normal client API key — not against a local build.

### Design Discovery

| Call | Result |
| :--- | :--- |
| `GET /discovery/taxonomy` | `200` — 12 garments, 107 design areas |
| `GET /discovery/categories` | `200` — 12 ids, 3 shot types, limits |
| `POST /discovery/search` structured | `200` |
| `POST /discovery/search` natural language | `200` |
| `POST /discovery/search` keywords only | `200` |
| `designType` not valid for its garment | `400 VALIDATION_ERROR` |
| Unknown `category` | `400 VALIDATION_ERROR` |
| Empty body | `400 VALIDATION_ERROR` |
| `limit` above max | `400 VALIDATION_ERROR` |
| Wrong API key | `401 UNAUTHORIZED_API_KEY` |

**Every anticipated failure returned 4xx. No 5xx was produced by any input**, which is the property
that keeps discovery from tripping the shared circuit breaker.

Result quality was checked too: for a 20-result search, all 20 `fetchable.url` values retrieved a
real image, and all 20 `fetchable.width`/`.height` pairs matched the decoded bytes exactly —
including the Instagram results, which correctly reported their true ~400 px size rather than the
original post's dimensions.

### Design Discovery — platforms, filters and streaming (15 September 2026)

Run against a **local build** with the real search provider (a dedicated test key), **not yet through
the production gateway** — the gateway checks still need repeating after deploy.

| Scenario | Result |
| :--- | :--- |
| Four platforms, stream | `start`, then four `source` events in finishing order, then `done`; first results ~2.3 s, slowest ~8 s |
| Platform purity | Pinterest, Instagram and Facebook searches each returned only their own platform |
| Duplicates across platforms | None returned; counted in `duplicates` |
| Upgraded Pinterest images | 38/38 sampled loaded at the larger size; a deliberately broken one fell back to `fallbackUrl` |
| `recency: "week"` | 0–1 of 30 results shared with `any`; cached separately |
| All result filters | Every returned result satisfied them; a filter matching nothing returned `200` with 0 results |
| Every platform failing (bad provider key) | `/search` returned `424`; the stream sent four error events and `done.status: "failed"` |
| Heartbeat | `: keepalive` sent while platforms were still working |
| Caller disconnecting mid-stream | Server finished quietly, logged it, kept serving |
| Malformed stream requests (bad JSON, 40 KB body, no `clientId`, wrong key, bad pair) | JSON `400` / `413` / `401` before any stream opened |
| Rate limit | Ten filter changes on a cached search all allowed; new searches refused at 20 calls with `Retry-After` |
| 24 simultaneous requests (12 JSON + 12 stream) | 24/24 succeeded |
| Visual check, top 8 per platform for a blouse-back search | Web, Pinterest, Instagram 8/8 relevant; Facebook relevant but 3/8 were collages or text posters |

Automated: 138 offline checks (a fake provider behind a real local HTTP server, including the stream)
plus the live suite (`npm run test:live`).

### Catalog generation

| Call | Result |
| :--- | :--- |
| Women, 4 views, garment supplied as a URL | `200`, 4 × `VIEW_READY` at 895×1200, then `COMPLETE` |
| Men, `SHERWANI`, `sizes: ["M"]` | `200`, `SIZE_READY` (476 KB JPEG), then `COMPLETE` — two events at the time, see the duplicate-event note |
| Missing `clientId`/`modelId` | `400` |
| Men without a garment image | `400` |
| `cancel-job` with no job running | `200`, `success: false` |
| `recommend-size` without a photo | `400` |

Measured end-to-end times through the gateway: **27.2 s, 27.4 s, 31.7 s** for a full four-view
women's catalog, and **12.2 s** for a single men's size.

One run was fed a flat-lay that Discovery itself had returned, so the full chain — **discovery →
generation → delivery** — is proven in a single pass, not just each part in isolation.

### Known limits of this verification

- Timings are from a warm service. A cold Render instance adds start-up time to the first call.
- Generation output is produced by an image model and is **not deterministic**; the same input can
  return a visibly different photograph each time.
- The mix-and-match (`tops`) path and `generate-user-tryon` were not exercised end-to-end; they are
  documented from their code, like everything marked as such above.
