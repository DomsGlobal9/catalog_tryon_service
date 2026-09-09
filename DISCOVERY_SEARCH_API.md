# Design Discovery — Search API

`POST /api/v1/discovery/search`

Give it keywords, or one line of plain English, and it returns **links to garment
design images found on the web**.

> **Browse-only.** This never downloads, stores or returns image bytes. It returns URLs and where
> they came from. Every result carries `sourceUrl` and `sourceDomain`; **responsibility for rights in
> any downstream use rests with you.**

---

## Endpoint

| | |
| :--- | :--- |
| **Production** | `https://api-super-admin.onrender.com/api/gateway/cat/api/v1/discovery/search` |
| **Method** | `POST` |
| **Headers** | `x-api-key: <your key>` and `Content-Type: application/json` |
| **Max body** | 32 KB |
| **Typical time** | 2–4 s live, under 100 ms when served from cache |

---

## Request payload

| Field | Type | Required | Notes |
| :--- | :--- | :--- | :--- |
| `clientId` | String | **Yes** | Your account identifier, 1–128 chars. Also the rate-limit bucket — keep it **stable**, don't randomise it. |
| `keywords` | String[] | * | 1–12 terms, each 1–64 chars. |
| `instruction` | String | * | One line of plain English, max 500 chars. |
| `category` | String | * | Garment id, max 64 chars. See the list below. |
| `designType` | String | No | A design area **of that garment**. Requires `category`. |
| `shotType` | String | No | `flatlay`, `worn`, or `any` (default). **Read the warning below.** |
| `filters.color` | String | No | e.g. `"emerald"`. Max 64 chars. |
| `filters.fabric` | String | No | e.g. `"organza"`. Max 64 chars. |
| `filters.occasion` | String | No | e.g. `"reception"`. Max 64 chars. |
| `page` | Number | No | 1–20, default 1. |
| `limit` | Number | No | 1–50, default 20. |

\* **You must send at least one of `keywords`, `category` or `instruction`.** Sending none is a `400`.

They combine freely. **Explicit fields always win**, and `instruction` only fills the gaps they leave.

### Garment ids

```
SAREE   BLOUSE   DUPATTA   KURTHI   ANARKALI   PETTICOAT
GOWN    SUIT     SHERWANI  BOTTOM_WEAR   LEHANGA   SHARARA
```

Note the spelling: **`LEHANGA`** (shown as *Lehenga*) and **`KURTHI`** (shown as *Kurti*). `LEHENGA`,
`KURTI`, `KURTA`, `SARI`, `GHAGRA` and `GHARARA` are accepted as aliases and converted — the
`interpreted` block in the response tells you what you actually got.

For the full list of design areas per garment (12 garments, 107 areas), call
`GET /api/v1/discovery/taxonomy`.

### ⚠️ `shotType` is a hint, not a filter

Setting `flatlay` just appends the words `flat lay product photo` to the search. **Nothing inspects
the images that come back**, so photos of people wearing the garment still appear.

Measured by inspecting every image returned across three searches (46 results):

| Search with `shotType: "flatlay"` | Results | Worn by a person |
| :--- | ---: | ---: |
| `red bridal saree` | 11 | 2 (18%) |
| `gold kanjivaram saree` | 15 | 8 (53%) |
| `blue anarkali` | 20 | **15 (75%)** |
| **Total** | **46** | **25 (54%)** |

It fails worst for **stitched garments** (anarkali, kurti, suit), which are nearly always
photographed on a model. If you need genuine flat-lays, you must check the images yourself.

The same applies to `filters.color` / `.fabric` / `.occasion` — they are folded into the search text,
and returned images are **not verified** to actually be that colour or fabric.

### Example requests

**Keywords only**
```json
{ "clientId": "acme-retail", "keywords": ["red", "bridal", "saree"], "limit": 20 }
```

**Garment + design area**
```json
{
  "clientId": "acme-retail",
  "category": "SAREE",
  "designType": "PALLU",
  "keywords": ["gold", "kanjivaram"],
  "filters": { "occasion": "wedding" }
}
```

**Plain English** — resolved against the taxonomy with no AI call and no added delay
```json
{
  "clientId": "acme-retail",
  "instruction": "I want red bridal kanjivaram saree pallu designs with heavy zari"
}
```

**Pin the garment, let the sentence find the area**
```json
{ "clientId": "acme-retail", "category": "LEHANGA", "instruction": "heavy zari deep red border" }
```

---

## Response

`200 OK`

```jsonc
{
  "success": true,
  "searchId": "b1f2c3d4-...",          // correlation id for logs only
  "query": "red bridal saree",         // what was actually sent to the search engine
  "cached": false,
  "interpreted": {
    "category": null,                  // null when you sent none and none was parsed
    "categoryName": null,
    "designType": null,
    "designTypeName": null,
    "keywords": ["red bridal saree"],
    "source": "structured",            // structured | instruction | mixed
    "confidence": "high",
    "unresolved": []                   // words it could not map to the taxonomy
  },
  "results": [ /* see below */ ],
  "pagination": { "page": 1, "limit": 20, "hasMore": true }
}
```

### A single result

This is a real response, not an invented one:

```jsonc
{
  "id": "result_1d3751718a0f",         // stable hash of imageUrl - same design, same id
  "position": 1,
  "title": "Luxury Red Bridal Saree with Silver Embroidery Designer Blouse",
  "imageUrl": "http://mangaldeep.co.in/cdn/shop/files/15_1522af92.jpg?v=1758882241",
  "thumbnailUrl": "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQLN-6SPR81...",
  "sourceUrl": "https://mangaldeep.co.in/products/luxury-red-bridal-saree",
  "sourceDomain": "mangaldeep.co.in",
  "width": 2000,
  "height": 3000,
  "thumbnailWidth": 365,
  "thumbnailHeight": 547,
  "imageUsable": true,

  "fetchable": {                        // ← the only part most callers need
    "url": "http://mangaldeep.co.in/cdn/shop/files/15_1522af92.jpg?v=1758882241",
    "width": 2000,
    "height": 3000,
    "from": "imageUrl"                  // imageUrl | thumbnailUrl
  }
}
```

### 👉 Just read `fetchable`

Every result holds two different truths:

| | Meaning |
| :--- | :--- |
| `imageUrl`, `width`, `height` | What the source **claims the original is** — whether or not you can retrieve it |
| `fetchable.url`, `.width`, `.height` | What you can **actually retrieve**, and its true size |

**If you only ever read `fetchable`, you are correct in every case** — no branching, and you never
need to know about Instagram, Facebook or `imageUsable`:

```js
const image = await fetch(result.fetchable.url);          // always a real image
store({ w: result.fetchable.width, h: result.fetchable.height });
```

Verified: across a 20-result search, **all 20** `fetchable.url` values retrieved a real image, and
**all 20** width/height pairs matched the actual decoded bytes exactly.

### Why it matters — an Instagram result

```jsonc
{
  "imageUrl": "https://lookaside.instagram.com/seo/google_widget/crawler/?media_id=388027895...",
  "width": 2298, "height": 4082,        // the original post - you CANNOT fetch this
  "thumbnailUrl": "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTyk6k9jOtEz...",
  "thumbnailWidth": 335, "thumbnailHeight": 597,
  "sourceUrl": "https://www.instagram.com/reel/DXZhSXiCT8D/",
  "sourceDomain": "www.instagram.com",
  "imageUsable": false,
  "fetchable": { "url": "https://encrypted-tbn0.gstatic.com/...",
                 "width": 335, "height": 597, "from": "thumbnailUrl" }
}
```

That `imageUrl` serves an **HTML page**, not an image. A caller who hotlinks it stores a dead link.
`width`/`height` say 2298×4082 but the only thing retrievable is **335×597** — a 7× difference. Read
`fetchable` and the problem disappears.

`width`/`height` are deliberately **not** rewritten: the original post genuinely is that big, and
that is legitimate provenance.

> **`fetchable.url` is point-in-time, not permanent.** It was retrievable when the search ran. CDN
> URLs, signed URLs and social thumbnails expire and rotate. If you intend to keep a design,
> **retrieve it promptly and store your own copy** — do not treat our URL as durable storage.

### Fields that mean less than they look

- **`searchId`** is a correlation id for logs. There is no database — nothing can be fetched by it later.
- **`hasMore`** is inferred, not authoritative. The search engine reports no total, so "a full page
  came back" is the only signal available.
- **`cached: true`** means it came from the in-process cache (1 hour). The cache empties on restart.

### What comes back, and from where

Results come from the open web **and** incidentally from social platforms. This is a **search**, not
a scrape — there is no Pinterest or Instagram crawler, and no way to ask for more of them.

Measured across 150 results from 5 searches:

| Source | Share |
| :--- | ---: |
| Retailers, marketplaces, blogs | 88% |
| Pinterest | 6% |
| Instagram | 5% |
| Facebook | 0.7% |

Some searches return **zero** social results. There is no `sources` parameter and `site:` operators
return nothing from this provider, so it cannot be forced.

**Instagram and Facebook designs are only ever available at ~400px** (measured: 335×597, 387×516,
447×447). Their `imageUrl` serves HTML and the thumbnail is all that exists. If you are feeding these
into a generation model, treat them as weak inputs.

Before returning, results are filtered: no image URL → dropped; duplicate image URL → collapsed;
smaller than 400×400 as reported by the provider → dropped; neither a usable `imageUrl` nor a
thumbnail → dropped. Results with an unreported size are kept. **So you will often get fewer results
than your `limit`** — 11 out of 20 requested is normal, not an error.

---

## Errors

All errors are shaped:

```json
{ "success": false, "error": { "code": "...", "message": "...", "details": [] } }
```

| Status | `error.code` | Meaning |
| :--- | :--- | :--- |
| `400` | `VALIDATION_ERROR` | Bad body. Also covers: unknown `category`, a `designType` that is not an area of its garment, `designType` without `category`, an instruction nothing could be resolved from, and sending no search terms at all. `details` names the field and lists what is valid. |
| `400` | `INVALID_JSON` | Body was not valid JSON. |
| `401` | — | Missing or wrong `x-api-key`. |
| `413` | `PAYLOAD_TOO_LARGE` | Body over 32 KB. |
| `429` | `RATE_LIMIT_EXCEEDED` | 20 searches per minute per `clientId` exceeded. Honour `Retry-After`. Cached hits still count. |
| `424` | `PROVIDER_UNAVAILABLE` | The upstream search provider failed, timed out or rejected us. |
| `424` | `DISCOVERY_NOT_CONFIGURED` | Discovery is switched off on this deployment. |

Example — a design area that does not belong to the garment:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "\"SLEEVE\" is not a design area of Saree.",
    "details": [{
      "field": "designType",
      "message": "Valid for SAREE: OVERALL, PALLU, BORDER, BODY, PLEAT, PRINT, EMBROIDERY, ZARI_WORK"
    }]
  }
}
```

**Note there is no `5xx` for an upstream outage.** Discovery shares a gateway route with catalog
generation, and that gateway trips a circuit breaker on repeated `5xx`. Reporting a provider outage
as `5xx` would take catalog generation offline as collateral damage, so every anticipated failure —
provider outages included — is reported as `4xx`.

---

## Minimal working example

```js
const res = await fetch(BASE + '/api/v1/discovery/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  body: JSON.stringify({
    clientId: 'acme-retail',
    category: 'SAREE',
    designType: 'PALLU',
    keywords: ['gold', 'kanjivaram'],
    limit: 20
  })
});

const body = await res.json();
if (!res.ok) throw new Error(body.error.message);

for (const r of body.results) {
  console.log(r.title, r.fetchable.url, `${r.fetchable.width}x${r.fetchable.height}`);
}
```

The URLs in `fetchable.url` can be passed straight into `POST /api/v1/draping/generate-catalog` as
the garment image — that endpoint accepts a public URL, so no download step is needed on your side.
