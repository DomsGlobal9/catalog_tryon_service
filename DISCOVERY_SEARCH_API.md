# Design Discovery — Search API

Give it keywords, or one line of plain English, and it returns **links to garment design images**
found on the web, **Pinterest**, **Instagram** and **Facebook**.

> **Browse-only.** This never downloads, stores or returns image bytes. It returns URLs and where
> they came from. Every result carries `sourceUrl` and `sourceDomain`; **responsibility for rights in
> any downstream use rests with you.**

There are two endpoints. They take **the same request body** and find **the same results**; they
differ only in how the answer is delivered.

| Endpoint | Answer | Use it when |
| :--- | :--- | :--- |
| `POST /api/v1/discovery/search` | One JSON body, after every platform has finished | You search one platform, or you just want the final list |
| `POST /api/v1/discovery/search/stream` | Server-Sent Events: each platform's results **the moment that platform finishes** | You search several platforms and want to show results as they arrive |

---

## Connecting

| | |
| :--- | :--- |
| **Base URL (production)** | `https://api-super-admin.onrender.com/api/gateway/cat` |
| **Headers** | `x-api-key: <your key>` and `Content-Type: application/json` |
| **Max body** | 32 KB |
| **Gateway timeout** | 90 s — every search finishes far inside it |

---

## Request body (both endpoints)

| Field | Type | Required | Notes |
| :--- | :--- | :--- | :--- |
| `clientId` | String | **Yes** | Your identifier for the user or session, 1–128 chars. Shown in logs. |
| `keywords` | String[] | * | 1–12 terms, each 1–64 chars. |
| `instruction` | String | * | One line of plain English, max 500 chars. |
| `category` | String | * | Garment id, max 64 chars. See the list below. |
| `designType` | String | No | A design area **of that garment**. Requires `category`. |
| `sources` | String[] | No | Any of `web`, `pinterest`, `instagram`, `facebook`. **Default `["web"]`.** Max 4. One search per platform, all run at the same time. |
| `recency` | String | No | `any` (default), `day`, `week`, `month`, `year`. Only images published in that period. |
| `resultFilters` | Object | No | Checked against every result — **guaranteed**. See below. |
| `shotType` | String | No | `flatlay`, `worn`, or `any` (default). A hint only — **read the warning below**. |
| `filters.color` / `.fabric` / `.occasion` | String | No | Words added to the search, max 64 chars each. **Not** verified against the images. |
| `page` | Number | No | 1–20, default 1. Applies to every platform. |
| `limit` | Number | No | 1–100, default 20. **Per platform.** |

\* **Send at least one of `keywords`, `category` or `instruction`.** Sending none is a `400`.

They combine freely. **Explicit fields always win**, and `instruction` only fills the gaps they leave.
Unknown fields inside `resultFilters` are rejected with `400`, so a typo cannot silently filter nothing.

### `resultFilters` — guaranteed filters

| Field | Type | Keeps only… |
| :--- | :--- | :--- |
| `fullSizeOnly` | Boolean | Results where the full image can be retrieved. Removes Instagram/Facebook previews. |
| `minWidth` | Integer | Results whose retrievable image is at least this wide. A result of **unknown** size is removed. |
| `orientation` | String | `portrait`, `landscape` or `square` (square = within 5%). Unknown size is removed. |
| `excludeDomains` | String[] | Everything **except** these sites, subdomains included. Max 20. `"amazon.in"` also removes `www.amazon.in`; a pasted URL is accepted. |

They are applied **after** the search is cached, so trying different filters on the same search costs
nothing extra — see *Rate limit* below.

### Garment ids

```
SAREE   BLOUSE   DUPATTA   KURTHI   ANARKALI   PETTICOAT
GOWN    SUIT     SHERWANI  BOTTOM_WEAR   LEHANGA   SHARARA
```

Note the spelling: **`LEHANGA`** (shown as *Lehenga*) and **`KURTHI`** (shown as *Kurti*). `LEHENGA`,
`KURTI`, `KURTA`, `SARI`, `GHAGRA` and `GHARARA` are accepted and converted — the `interpreted` block
in the response shows what you actually got. The full list of design areas per garment (12 garments,
107 areas) is at `GET /api/v1/discovery/taxonomy`.

### Plain English

`instruction` is matched against the garment taxonomy with no AI call and no added delay:

```json
{ "clientId": "acme-retail", "instruction": "i want red zari saree pallu designs" }
```

resolves to `SAREE` / `PALLU` with keywords `["red", "zari"]`. When a sentence names both a **part** of
a garment (pallu, border, neck, sleeve…) and a **finish** (zari work, embroidery, print), the part is
the design area and the finish stays as a keyword. A sentence with nothing searchable in it — e.g.
"please help me thanks" — is refused with `400` rather than run as a paid search.

### Example requests

**All four platforms**
```json
{
  "clientId": "acme-retail",
  "category": "BLOUSE",
  "designType": "BACK",
  "keywords": ["designer"],
  "sources": ["web", "pinterest", "instagram", "facebook"],
  "limit": 30
}
```

**Recent Pinterest and Instagram designs, full-size portrait images only**
```json
{
  "clientId": "acme-retail",
  "instruction": "gold zari saree pallu designs",
  "sources": ["pinterest", "instagram"],
  "recency": "month",
  "resultFilters": { "fullSizeOnly": true, "orientation": "portrait" }
}
```

**Good inputs for catalog generation** — large, full images, no marketplace listings
```json
{
  "clientId": "acme-retail",
  "category": "SAREE",
  "designType": "PALLU",
  "keywords": ["kanjivaram"],
  "sources": ["web", "pinterest"],
  "resultFilters": { "fullSizeOnly": true, "minWidth": 700, "excludeDomains": ["amazon.in", "meesho.com"] }
}
```

---

## Response — `POST /search`

`200 OK`

```jsonc
{
  "success": true,
  "searchId": "98cd08ae-703f-4298-a60e-0213289f5506",   // for logs only
  "query": "designer blouse back design",               // the first source's query
  "cached": false,                                      // true only if every source came from cache
  "interpreted": {
    "category": "BLOUSE", "categoryName": "Blouse",
    "designType": "BACK", "designTypeName": "Back Design",
    "keywords": ["designer"],
    "source": "structured",                             // structured | instruction | mixed
    "confidence": "high",
    "unresolved": []
  },
  "results": [ /* see "A single result" */ ],
  "sources": [ /* one summary per platform, in the order you asked - see below */ ],
  "pagination": { "page": 1, "limit": 30, "hasMore": true }
}
```

`results` is ordered by platform, **in the order you listed `sources`**, then by rank within each — so
the same request always returns the same order.

**If one platform fails, you still get `200`** with the others' results; the failure is described in
its `sources` entry. Only when **every** platform fails does `/search` return an error (`424`).

### Per-platform summary — `sources[]`

```jsonc
{
  "source": "pinterest",
  "query": "designer blouse back design pinterest",   // what was actually searched
  "status": "ok",                                     // ok | error
  "cached": false,
  "durationMs": 3181,
  "returned": 14,           // results from this platform in the response
  "duplicates": 2,          // found here, but already returned by an earlier platform
  "offPlatform": 14,        // results from other sites, dropped - you asked for Pinterest
  "removedByFilters": 0,    // removed by your resultFilters
  "hasMore": true
}
```

A failed platform looks like:

```json
{
  "source": "facebook", "query": "red saree facebook page", "status": "error",
  "cached": false, "durationMs": 15002,
  "error": { "code": "PROVIDER_UNAVAILABLE", "message": "Serper did not respond within 15000ms." }
}
```

### A single result

A real result — a Pinterest pin that the **web** search found:

```jsonc
{
  "id": "result_a236ed96f694",          // stable hash of imageUrl - same design, same id
  "position": 7,                        // rank within the search that found it
  "title": "Discover 240 Blouse back and new saree blouse designs ideas in 2026",
  "imageUrl": "https://i.pinimg.com/474x/28/92/94/28929456b37329bf0ca4d310a8c0e014.jpg",
  "thumbnailUrl": "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRJuIyxSAAJ...",
  "sourceUrl": "https://in.pinterest.com/shinyvarg/blouse-back/",
  "sourceDomain": "in.pinterest.com",
  "width": 474,
  "height": 593,
  "thumbnailWidth": 201,
  "thumbnailHeight": 251,
  "platform": "pinterest",              // the site this design is from
  "foundBy": "web",                     // the platform search that found it
  "imageUsable": true,
  "fetchable": {                        // <- the only part most callers need
    "url": "https://i.pinimg.com/736x/28/92/94/28929456b37329bf0ca4d310a8c0e014.jpg",
    "width": 736,
    "height": 921,
    "from": "imageUrl",                 // imageUrl | thumbnailUrl
    "sizeExact": false,                 // width/height here are an estimate - see below
    "fallbackUrl": "https://i.pinimg.com/474x/28/92/94/28929456b37329bf0ca4d310a8c0e014.jpg"
  }
}
```

### Just read `fetchable`

Every result holds two different truths:

| | Meaning |
| :--- | :--- |
| `imageUrl`, `width`, `height` | What the source **reports** — kept as provenance, whether or not it can be retrieved |
| `fetchable.url`, `.width`, `.height` | What you should **actually retrieve**, and its size |

**If you only ever read `fetchable`, you are correct in every case** — no branching on platform:

```js
const image = await fetch(result.fetchable.url);
```

| `fetchable` field | Meaning |
| :--- | :--- |
| `sizeExact` | `true`: `width`/`height` are the reported size of this exact URL. `false`: they are **our estimate** (only on upgraded Pinterest images). |
| `fallbackUrl` | Present only on upgraded Pinterest images. The original, smaller image — use it if `url` ever fails to load. |

> **`fetchable.url` is point-in-time, not permanent.** It was retrievable when the search ran. CDN
> URLs and social thumbnails expire and rotate. If you intend to keep a design, **retrieve it promptly
> and store your own copy.**

### Fields that mean less than they look

- **`searchId`** is for logs. There is no database — nothing can be fetched by it later.
- **`hasMore`** is inferred: the search engine reports no total, so "a full page came back" is the only
  signal. It is `true` if any platform returned a full page.
- **`position`** is the rank inside the search that found the result, and is **not renumbered** after
  unusable results are removed — gaps (e.g. 38, 40, 41) are normal.
- **`cached: true`** means the in-process cache answered (1 hour). It empties on restart.

---

## Response — `POST /search/stream`

The same search, delivered as **Server-Sent Events** (`Content-Type: text/event-stream`).

**Why use it:** every platform starts at the same moment, but they finish at different times. Measured
on real four-platform searches, the first results were ready after **~2.3 s** while the slowest
platform took up to **~8 s**. `/search` makes you wait for the slowest; the stream shows each
platform's results as soon as they exist.

### How it works

The connection stays open and the server writes one message per step. Each message is a line
starting `data: ` followed by JSON, then a blank line:

```
data: {"type":"start", ...}

data: {"type":"source","source":"web", ...}

: keepalive 1757934821456

data: {"type":"source","source":"instagram", ...}

data: {"type":"done", ...}
```

Lines starting with `:` are **keep-alive** messages, sent every 10 s while waiting, so no proxy closes
an idle connection. Ignore them.

| Event `type` | When | Contains |
| :--- | :--- | :--- |
| `start` | Immediately | `searchId`, `interpreted`, `page`, `limit`, and `sources[]` — each platform with the exact `query` it is about to send |
| `source` | Once per platform, **in the order they finish** | The same summary as `/search`'s `sources[]` entry. When `status` is `ok` it also has `results`; when `error` it has `error` instead |
| `done` | Last | `status` (`ok` \| `partial` \| `failed`), `total`, `cached`, `hasMore`, `durationMs`, and the final `sources[]` in the order you asked |
| `error` | Only on an unexpected server fault | `code`, `message`. The stream then ends |

A design found by two platforms is sent **once** — by whichever platform finished first. The other
counts it under `duplicates`.

### Errors before the stream starts

A request that is invalid, unauthorised, over the rate limit, or sent while discovery is switched off
is refused **before any stream opens**, as an ordinary JSON error with its normal status (`400`, `401`,
`413`, `424`, `429`). So: **check the status and `Content-Type` first.** Only `200` with
`text/event-stream` is a stream.

Once the stream is open the status is already `200`, so a platform that fails is reported in its own
`source` event (`"status": "error"`), and the other platforms carry on. If every platform fails, `done`
arrives with `"status": "failed"`.

### Reading the stream

The browser's `EventSource` cannot send a POST body or the `x-api-key` header, so read the response
body directly. This works in browsers and Node 18+:

```js
const res = await fetch(BASE + '/api/v1/discovery/search/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  body: JSON.stringify({
    clientId: 'acme-retail',
    keywords: ['red', 'bridal', 'saree'],
    sources: ['web', 'pinterest', 'instagram', 'facebook']
  })
});

// Refused up front? It is plain JSON.
if (!res.ok) throw new Error((await res.json()).error.message);

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  let boundary;
  while ((boundary = buffer.indexOf('\n\n')) >= 0) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    if (!frame.startsWith('data: ')) continue;       // skips ": keepalive"
    const event = JSON.parse(frame.slice(6));

    if (event.type === 'source' && event.status === 'ok') showResults(event.source, event.results);
    if (event.type === 'source' && event.status === 'error') showFailure(event.source, event.error.message);
    if (event.type === 'done') finish(event.status, event.total);
  }
}
```

To cancel, abort the request (`AbortController`). The server notices, stops sending, and lets the
searches already in progress finish so their results are cached for your next request.

---

## Platforms — what each one gives you

There is no Pinterest, Instagram or Facebook API behind this, and nothing is scraped. Each platform is
the same image search with the platform's name added to it — `site:` filters return **zero** results
from the search provider, while adding the name works. A platform search then keeps **only** that
platform's results. Measured share of raw results that came from the intended platform:

| Platform | Words added | Share on target | Retrievable image |
| :--- | :--- | ---: | :--- |
| `instagram` | `instagram` | **80–89%** | Preview only, ~330–450 px |
| `pinterest` | `pinterest` | 30–46% | **Full image**, typically 600–736 px |
| `facebook` | `facebook page` | 10–40% | Mostly preview only |
| `web` | nothing | — | Full image |

What that means in practice:

- **Instagram** reliably finds Instagram posts, but Instagram only lets anyone retrieve a small preview.
  The original is not accessible. Treat these as **browsing references**, not generation inputs.
- **Pinterest** gives real, usable images. Most Pinterest images are indexed at 236 or 474 px; they are
  automatically **upgraded to the 736 px version** of the same image. Measured by downloading them,
  38 of 38 upgraded images loaded. The 736 px version is never smaller than the original, but it is not
  always exactly 736 wide, so its size is marked `sizeExact: false` and the original is kept as
  `fallbackUrl`.
- **Facebook** returns fewer results, mostly previews, and a noticeable share are **collages or text
  posters** (3 of 8 in one visual check) rather than a single design.
- **Web** is the broadest source and may itself include some Pinterest/Instagram results — its
  `platform` field tells you. It is the best source of full-size, single-design images.

**Recency** is applied by the search engine to every platform's search. Measured on a web search:
`week` and `month` shared **0 of 30** results with `any`, `year` shared 8 of 30.

### What is removed before you see results

- entries with no image URL, and duplicate image URLs
- images **smaller than 150 px** in either direction, as reported — genuine icons and junk (measured:
  none of 500 real results were this small, so no real design is lost)
- results with neither a retrievable image nor a preview

Results of unknown size are kept. **You will often get fewer results than `limit`** — that is filtering,
not an error. `sources[].offPlatform`, `duplicates` and `removedByFilters` tell you where they went.

### ⚠️ `shotType` is a hint, not a filter

`flatlay` adds the words `flat lay product photo` to the search. **Nothing inspects the images that
come back**, so photos of people wearing the garment still appear. Measured by inspecting every image
across three searches (46 results):

| Search with `shotType: "flatlay"` | Results | Worn by a person |
| :--- | ---: | ---: |
| `red bridal saree` | 11 | 2 (18%) |
| `gold kanjivaram saree` | 15 | 8 (53%) |
| `blue anarkali` | 20 | **15 (75%)** |

It fails worst for **stitched garments** (anarkali, kurti, suit). If you need genuine flat-lays, check
the images yourself. `filters.color / fabric / occasion` are likewise search words, not verified.

---

## Cost and limits

**Each platform is one search-provider call.** A search across four platforms is four calls.

| Results asked for (`limit`) | Provider credits per platform |
| :--- | ---: |
| 10 | 1 |
| 20, 50 or 100 | 2 (measured — the same for all three) |

So one call for 100 results costs the same as one call for 20. If you want many results, ask for them in
one page rather than paging through small ones — each page is a fresh set of calls.

### Rate limit

**20 provider calls per minute per API key account.** Using a different `clientId` does not give you a
new budget. Only calls actually made to the provider count:

| Request | Counts as |
| :--- | :--- |
| New search, `sources: ["web"]` | 1 |
| New search across all four platforms | 4 |
| The same search again (from cache), e.g. with different `resultFilters` or re-opened | **0** |

A request that would go over the limit is refused **without using any of your budget** — `429` with a
`Retry-After` header and a message saying how many calls it needed and how many remain.

### At busy moments

The search provider limits how many searches one account may run at the same moment. The service
handles that for you:

- At most 10 provider calls run at once; others **wait their turn** rather than being refused. During a
  burst a platform's results therefore arrive a few seconds later, not missing. A call that cannot get a
  turn within 20 s fails with `424` and the message *"Search capacity is busy"*.
- If the provider still answers "too many requests" or has a temporary fault, the call is **retried
  twice** after a short wait. The error you finally see, if any, ends with *"(after 3 attempts)"*.
- A provider timeout or a rejected key is **not** retried — waiting again would not help.

Measured: 12 four-platform searches started together (48 provider calls) — all 48 succeeded in 13.6 s.
Before this queue, 8 such searches (32 calls) lost 7 calls to the provider's limit.

---

## Errors

```json
{ "success": false, "error": { "code": "...", "message": "...", "details": [] } }
```

| Status | `error.code` | Meaning |
| :--- | :--- | :--- |
| `400` | `VALIDATION_ERROR` | Bad body: unknown `source`, `recency` or `resultFilters` key; unknown `category`; a `designType` not of its garment; `designType` without `category`; an instruction with nothing searchable; no search terms. `details` names the field and what is valid. |
| `400` | `INVALID_JSON` | Body was not valid JSON. |
| `401` | — | Missing or wrong `x-api-key`. |
| `413` | `PAYLOAD_TOO_LARGE` | Body over 32 KB. |
| `429` | `RATE_LIMIT_EXCEEDED` | Provider-call budget used up. Honour `Retry-After`. |
| `424` | `PROVIDER_UNAVAILABLE` | `/search` only, when **every** platform failed (timed out, or the provider rejected us). |
| `424` | `DISCOVERY_NOT_CONFIGURED` | Discovery is switched off on this deployment. |

Example:

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

**There is no `5xx` for a provider outage.** Discovery shares a gateway route with catalog generation,
and that gateway trips a circuit breaker on repeated `5xx`. Reporting an outage as `5xx` would take
catalog generation offline too, so every anticipated failure is reported as `4xx`.

---

## Discovering the options at runtime

`GET /api/v1/discovery/categories` returns the current garment ids, `sources`, `recency` values,
`shotTypes`, the `resultFilters` shape, and `limits` (`maxLimit`, `maxPage`, `maxSources`), so a
client can build its controls without hard-coding them.

## Using a result for catalog generation

`fetchable.url` can be passed straight into `POST /api/v1/draping/generate-catalog` as the garment
image — that endpoint accepts a public URL, so you never have to download anything. For the best
generation input, search with `"resultFilters": { "fullSizeOnly": true, "minWidth": 700 }`.
