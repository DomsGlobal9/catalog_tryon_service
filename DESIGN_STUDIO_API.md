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
| **Output** | JPEG, portrait **3:4** (about 900 × 1200 px), plain studio background, as base64. Full length, except a blouse (waist-up). **Two photographs (front and back)** for every garment by default; `views` can ask for one side |

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
| `designs[].groundColorHex` | string | No | e.g. `"#F2E8DC"`. The base colour **this part** must be, whatever colour the reference photo happens to be on. **You rarely need it**: if the fabric covering that part states a colour, that colour is used automatically. Set this only to override. |
| `designs[].groundColor` | string, ≤60 | No | The same in words, e.g. `"ivory"`. |
| `designs[].keepMotifColors` | boolean | No | Default `true`: the motifs keep the reference's own colours, including multi-coloured ones. `false` recolours them to suit the part's fabric. |
| `designs[].coverage` | `full` or `reference` | No | Default `full`: the design covers the whole part with no large plain gaps. `reference` follows the reference's own layout, including any plain areas it shows. |
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
| `modelGender` | `female` or `male` | No | Defaults to `female` for every garment (the `SHERWANI` here is a women's sherwani-style jacket; the men's sherwani is made by the Catalog Try-On men pipeline). |
| `views` | string[] | No | Which photographs to make: `["front", "back"]` (the default, for every garment), `["front"]` or `["back"]`. See *Front and back*. |
| `presentation` | `model`, `mannequin` or `sketch` | No | How the garment is shown. `model` (the default): on a person, as always. `mannequin`: on a headless dress-form mannequin. `sketch`: one fashion-illustration sheet with labels. See *Presentations*. |
| `pairWith` | object | No | What the model wears **with** the product — a saree's blouse, a blouse's saree. See *The product, and what it is worn with*. |
| `pairWith.color` | string, ≤60 | No | e.g. `"antique gold"`. |
| `pairWith.colorHex` | string | No | e.g. `"#C9A227"`. |
| `pairWith.note` | string, ≤300 | No | e.g. `"short puff sleeves"`, `"matte crepe skirt"`. |
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
| `pairedWith`, `pairWith.colour` | `pairWith`, `pairWith.color` |

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

### If your payload comes from the design library

This shape is accepted exactly as the design library produces it - no rewriting needed:

```json
{
  "clientId": "shop-42-user-9",
  "garment_key": "blouse",
  "product_name": "Blouse",
  "parts": {
    "front_design": { "part": "front_design", "sequence": 0, "image_url": "https://res.cloudinary.com/acme/image/upload/v1/front.jpg", "part_label": "Front Design", "caption": "" },
    "back_design":  { "part": "back_design",  "sequence": 1, "image_url": "https://res.cloudinary.com/acme/image/upload/v1/back.jpg",  "part_label": "Back Design",  "caption": "" },
    "hand_design":  { "part": "hand_design",  "sequence": 2, "image_url": "https://res.cloudinary.com/acme/image/upload/v1/hand.jpg",  "part_label": "Hand Design",  "caption": "keep the tassels" }
  },
  "fabrics": {
    "MAIN_FABRIC": ["https://res.cloudinary.com/acme/image/upload/v1/fabric-main.jpg"],
    "BORDER": ["https://res.cloudinary.com/acme/image/upload/v1/fabric-border.jpg"],
    "LINING": ["eeedba61-3b50-48ad-942b-a68a7d342f47"]
  },
  "model_image": "data:image/jpeg;base64,/9j/4AAQ...",
  "part_refs": {},
  "notes": ""
}
```

| Design-library name | Same as | Notes |
| :--- | :--- | :--- |
| `garment_key` | `garment` | |
| `product_name` | `productName` | |
| `parts` as an object | `designs` | The key (`front_design`, `back_design`, `neck_design`, `hand_design`, `sleeve_design`, ...) names the area; `_design` is dropped. Ordered by `sequence`. |
| `parts.*.image_url` | `designs[].image` | |
| `parts.*.caption` | `designs[].note` | Only when not empty |
| `parts.*.part_label`, `id`, `design_id`, `design_title`, `designer_name`, `part_refs` | accepted, not used | Your own bookkeeping |
| `fabrics` as an object of roles | `fabrics[]` | `MAIN_FABRIC` is the main fabric; `BORDER` applies to the `BORDER` area (dropped when the garment has no border area, like a blouse); `LINING` and `BACKING_FABRIC` are inside the garment and never used. |
| `model_image` | `modelImage` | A link or base64 |

**A fabric must be a picture.** The design library stores fabric **ids** (`639c8187-...`). Only your
system can turn an id into its picture, so replace each id with the fabric's Cloudinary link or base64
before sending. An id sent as-is is refused: `400` with `FABRIC_ID_NOT_IMAGE` naming the entry.

### Images

Every image is **either**:

- **base64** — raw, or as a data URI (`data:image/jpeg;base64,...`), **or**
- an **https Cloudinary link** (`https://res.cloudinary.com/...`). No other websites are downloaded.

JPEG, PNG, WebP, AVIF and HEIC are accepted. Each image may be up to **12 MB**, and the whole
request up to **50 MB**. Images at least **1000 px** on their longest side give the best detail; under
512 px works with less fine detail, and under 64 px is refused.

### Colours: where each part's base colour comes from

1. `designs[].groundColorHex` / `groundColor` for that part, if you send it;
2. otherwise the **colour of the fabric covering that part** (`fabrics[].colorHex` / `color`);
3. otherwise, if that fabric has no stated colour, **the colour read from the fabric photograph**;
4. the design reference supplies **shape, construction and motifs** - the colour of the garment it was
   photographed on is never used. The service names that colour to the image model and tells it what
   replaces it.

Measured: a sleeve design photographed on mustard made mint sleeves mustard, and a
gota border photographed on royal blue made a rust lehenga's hem blue. With the
fabric's colour applied automatically, both came out in the intended colour. Measured again:
navy-and-white skirt tiers and a black waist belt from two gown photos were copied onto a lilac gown
until the reference colours were named and replaced.

### The product, and what it is worn with

A model has to wear something besides a blouse or a dupatta — but **only one garment is the
product**: the one named in `garment`. Every design you send belongs to it. Anything else the model
wears is a **supporting piece**: plain and solid, never carrying any of your designs. And the
photograph is **framed so the product fills it**, with every part of the product inside the frame
and the supporting pieces mostly out of it.

| `garment` | Framing | Worn with (never designed) | Its colour by default |
| :--- | :--- | :--- | :--- |
| `BLOUSE` | **waist-up** — head to upper thighs | a plain skirt, only its waistband in frame. **No saree, no pallu, no drape.** | a quiet neutral that sets the blouse off |
| `DUPATTA` | full length, so both hanging ends and any tassels show | a plain straight kurta with no drape or border | a quiet neutral |
| `SAREE` | full length | a plain **sleeveless** blouse | the saree's main fabric colour |
| `LEHANGA` | full length | a fitted short choli and a light dupatta | the lehenga's main fabric colour |
| `ANARKALI` | full length | a fitted churidar | the Anarkali's main fabric colour |
| `PETTICOAT` | full length | a short fitted blouse ending at the waist | a quiet neutral |
| `BOTTOM_WEAR` | full length | a short fitted top ending at the waist | a quiet neutral |
| `KURTHI` | full length | slim churidar or leggings | coordinates with the kurti |
| `SHERWANI` (women's) | full length | a fitted churidar | coordinates with the sherwani |
| `GOWN`, `SUIT`, `SHARARA` | full length | nothing — the product is the whole outfit | — |

"Main fabric colour" is the `color` / `colorHex` of the fabric **without** `appliesTo`.

Why the framing differs, measured: a blouse worn with a saree was a small strip at the top of a
full-length photo, and the saree's pallu covered a third of the blouse even when told to pin it
back. A dupatta is full length because its decorated ends and tassels hang to about the knee; a
head-to-mid-calf crop was tried and the image model framed three of four dupattas head to toe
anyway, so full length is what is promised. A `BACK` design keeps the same framing and turns the
model around.

A contrast panel keeps its own colour. A red embroidered yoke on a blue kurta stays red on your
fabric, while embroidery photographed on a garment of the same colour takes your fabric's colour.
The call is dependable on close-ups; on a small yoke in a full-length photo it can go either way, so
send `designs[].groundColorHex` when the colour of that panel matters.

To choose the supporting piece's colour or look yourself, send `pairWith`:

```json
{ "garment": "SAREE", "pairWith": { "color": "antique gold", "colorHex": "#C9A227", "note": "short puff sleeves" } }
```
```json
{ "garment": "BLOUSE", "pairWith": { "color": "cream", "colorHex": "#F3EAD7", "note": "matte crepe skirt" } }
```

Your designs still never go on the supporting piece, even with a `note`. If you send `pairWith` for
a garment that is the whole outfit (`GOWN`, `SUIT`, `SHARARA`), it is simply not used. `GET /options`
lists the supporting pieces and default colour for every garment.

Why this exists, measured: when the blouse was only described as "plain unless a design reference
describes it", a saree's pallu design came out on the blouse instead.

### Using your own model

Send a photo of the person to dress in `modelImage` (`modelImageUrl` in a catalogue payload). It is
given like any other image: base64, or an https Cloudinary link. Without it, a professional model is
created for you.

```json
{
  "clientId": "shop-42-user-9",
  "garment": "SAREE",
  "designs": [{ "area": "PALLU", "image": "https://res.cloudinary.com/acme/image/upload/v1/pallu.jpg" }],
  "fabrics": [{ "image": "https://res.cloudinary.com/acme/image/upload/v1/silk.jpg", "color": "wine", "colorHex": "#6D1A36" }],
  "modelImage": "https://res.cloudinary.com/acme/image/upload/v1/our-model.jpg"
}
```

What happens with that photo:

- **The same person is dressed.** Their face, skin tone, hair, body shape and proportions are kept.
- **Only the clothes change.** Their own outfit, pose, background and lighting are not used: the result
  is the usual catalogue photograph, with a plain studio backdrop, 3:4, full length (waist-up for a
  `BLOUSE`), posed to show every part you sent a design for.
- **It is only the person, never a design.** Nothing from the model photo (their clothes, jewellery or
  background) is copied onto the garment.
- `modelGender` is not needed with a model photo; without one, it chooses the generated model.
- Send **the same `modelImage` across a collection** to show every product on the same person.

A good model photo:

| | |
| :--- | :--- |
| **Person** | One person, facing the camera, standing, the whole body in the frame |
| **Clothes** | Plain, fitted clothes (a plain T-shirt and trousers, or a plain dress) |
| **Light** | Even daylight or studio light, the face clearly visible, no sunglasses or face covering |
| **Size** | At least 1000 px tall; up to 12 MB like any image |
| **Consent** | You must have the person's permission to use their photograph |

### Front and back

Every garment has a front and a back that both matter, and one photograph cannot show both. Every
garment therefore gives **two photographs** by default, in this order (since 10 October 2026; before,
only the blouse, kurti, anarkali, salwar suit and sherwani did, and the rest gave one front photograph):

1. **Front.** The model faces the camera. The `FRONT`, `NECK`, `BUTTON` and `POCKET` designs are
   shown here, along with everything that shows from both sides (sleeves, hems, borders, collars,
   all-over prints). The `BACK` design is *not* shown to the image model for this photograph.
2. **Back, made from the front.** The finished front photograph is given to the image model as the
   ground truth for the garment's colour, fabric, cut, sleeves, hem and the model herself; only the
   `BACK` design and the shared parts are added. The model turns her back squarely to the camera and
   looks back over one shoulder, hair pinned up or brought forward, so the whole back is visible.
   Each photograph is then checked **against its own reference pictures** (neckline shape and depth,
   motifs, sheer panels staying sheer, trims), and the back is also checked against the front (same
   cloth and cut, same sleeves, same person, a true back view with the arms at the sides, same studio,
   same supporting piece). Anything that differs is named and that photograph is made once more.

With **no `BACK` design**, the back photograph is still made, plain, in the garment's fabric. To make
only one side, send `views: ["front"]` or `views: ["back"]`. The order is always front then back.
With `views: ["back"]` alone there is no front photograph, so the checks that compare back with front are skipped; the back is still checked against its references.

A design that only shows from one side goes only to that photograph: `BACK` to the back; `FRONT`, `NECK`,
`BUTTON`, `POCKET` and a saree's `PLEAT` to the front. So `views: ["front"]` with a `BACK` design leaves
that design out; leave `views` out to get both.

**How the draped garments look from behind** (the same outfit as the front photograph):

| Garment | Back photograph |
| :--- | :--- |
| Saree | The same Nivi drape from behind: wrapped round the hips, the border along the hem all the way round, the plain blouse back. The pleats are at the front and not seen. The pallu is draped the classic way for this photograph, over the left shoulder and down the back, so its whole design shows (the front photograph shows it hanging in front). |
| Lehenga | The back of the choli and the skirt, the hem border all the way round; the dupatta falls down the left side, clear of the back. |
| Dupatta | Re-draped across the back and over both shoulders, both decorated ends hanging freely down the back, so its body, borders and ends show. (The front photograph drapes it round the neck with the ends in front.) |
| Sharara, gown, petticoat, bottom wear | The same garment turned round. A gown or sharara with no `BACK` design has a plain back. |
| Gown, Anarkali with a `BACK` design | The `BACK` design decorates the **back of the bodice only** (neck shape, keyhole or tie-up, back yoke). The skirt or flare at the back looks exactly like it does in the front photograph, even when the `BACK` picture shows a whole garment with motifs on its skirt. |

Borders, hem bands, body motifs and prints of a saree, lehenga, dupatta, petticoat or bottom wear run all
the way round, so they continue on the back.

Each photograph arrives as its own `image` event with a `view` of `"front"` or `"back"`. A request
for both takes roughly **25–35 seconds longer** than a single photograph, plus about 35 seconds for each
photograph that had to be made again. Measured on 10 October 2026, one front-and-back request per garment:
saree 60–81 s, lehenga 75 s, sharara 49 s, gown 40–46 s, dupatta 45–120 s, petticoat 75 s, bottom wear 54–62 s
(local runs, no photograph made again). In production an Anarkali pair took **154 s** - most likely one photograph was made once more after the
reference check (the default stream does not say) - so allow **240 seconds** on your side.

#### Verified on 10 October 2026

Reference pictures came from the live Design Discovery endpoint: for each design, the clearest of the first four usable results, picked before any photograph was made.

| Garment | Designs sent | Front + back result |
| :--- | :--- | :--- |
| Saree | `PALLU`, `BORDER` | Correct pair: the border runs round the hem, one pallu, the same saree in both. First run: the pallu fell down the back while the front showed it in front - the back view now drapes it down the back on purpose. |
| Lehenga | `SKIRT` | Correct first time: the skirt design continues round the back, plain choli back, the dupatta down the left side. |
| Sharara | `FLARE_PANTS` | Correct first time: plain kurti back, the pants' embroidered hem continues round. |
| Gown | `SKIRT_FLARE`, `BACK` | Correct after the fix: the keyhole back design on the bodice only, the skirt at the back as plain as in front. Before it, the `BACK` picture's leaf motifs spread onto the skirt and a waistband appeared. |
| Dupatta | `BODY` | Correct after the fix: draped across the back, both ends hanging free. Before it, the model held the ends out. |
| Petticoat | `BOTTOM_BORDER` | Correct first time: the lace border all the way round. |
| Bottom wear | `LEG` | Correct: the print continues round, the waistband matches. One run added a small inset close-up to the back photograph; it did not happen again. |
| Anarkali (production, through the gateway) | `FLARE`, `BACK` | Correct: the floral flare in both photographs; the back's dori tie-up with tassels on the bodice only; the `BACK` picture's own white flare did not leak in. |

In production, 28 checks that make no image call also pass: every garment lists `front` and `back` in
`/options`, a `views` value other than `front`/`back` is a `400` naming `views[0]`, and every combination
of `views` is accepted and reaches the image checks.

**Cost and time.** Two photographs cost two image calls and two reference checks, against one of each for
a single photograph. Send `views: ["front"]` where a back photograph is not needed.

#### Example requests

In every example `image` is a Cloudinary `https://res.cloudinary.com/...` link or base64
(`"data:image/jpeg;base64,/9j/4AAQ..."`); the links below are placeholders.

**1. Front and back (the default) - a saree from a pallu and a border design.** No `views`, so two
photographs come back: `front`, then `back`.

```json
{
  "clientId": "acme-retail",
  "productName": "Teal Banarasi Silk Saree",
  "garment": "SAREE",
  "designs": [
    { "area": "PALLU",  "image": "https://res.cloudinary.com/acme/image/upload/v1/designs/pallu-paisley.jpg" },
    { "area": "BORDER", "image": "https://res.cloudinary.com/acme/image/upload/v1/designs/border-peacock.jpg" }
  ],
  "fabrics": [
    { "image": "https://res.cloudinary.com/acme/image/upload/v1/fabrics/teal-silk.jpg", "name": "Banarasi silk", "color": "teal", "colorHex": "#0E7C7B" }
  ]
}
```

**2. Front only.** Half the cost and time. A `BACK` design sent with `views: ["front"]` is left out.

```json
{
  "clientId": "acme-retail",
  "garment": "LEHANGA",
  "views": ["front"],
  "designs": [
    { "area": "SKIRT",  "image": "https://res.cloudinary.com/acme/image/upload/v1/designs/lehenga-skirt.jpg" },
    { "area": "BORDER", "image": "https://res.cloudinary.com/acme/image/upload/v1/designs/lehenga-hem.jpg" }
  ]
}
```

**3. Back only.** No front photograph is made, so nothing is compared with one; the back is still
checked against its references.

```json
{
  "clientId": "acme-retail",
  "garment": "BLOUSE",
  "views": ["back"],
  "designs": [
    { "area": "BACK", "image": "https://res.cloudinary.com/acme/image/upload/v1/designs/keyhole-back.jpg", "note": "keep the tie-up latkans" }
  ]
}
```

**4. A garment with its own back design - a gown.** `SKIRT_FLARE` goes on both photographs; `BACK`
decorates the back of the bodice in the back photograph only.

```json
{
  "clientId": "acme-retail",
  "garment": "GOWN",
  "designs": [
    { "area": "SKIRT_FLARE", "image": "https://res.cloudinary.com/acme/image/upload/v1/designs/gown-skirt.jpg" },
    { "area": "BACK",        "image": "https://res.cloudinary.com/acme/image/upload/v1/designs/gown-keyhole-back.jpg" }
  ],
  "fabrics": [ { "image": "https://res.cloudinary.com/acme/image/upload/v1/fabrics/red-crepe.jpg", "color": "red" } ]
}
```

**5. A dupatta, with base64 instead of a link.**

```json
{
  "clientId": "acme-retail",
  "garment": "DUPATTA",
  "designs": [
    { "area": "BODY",      "image": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ..." },
    { "area": "PALLU_END", "image": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ..." }
  ]
}
```

**What comes back** for examples 1, 4 and 5 (the default `image` stream; base64 shortened):

```
data: {"type":"start","jobId":"6c1f2a9e-..."}

data: {"type":"image","jobId":"6c1f2a9e-...","view":"front","mimeType":"image/jpeg","width":896,"height":1200,"image":"data:image/jpeg;base64,/9j/4AAQ..."}

data: {"type":"image","jobId":"6c1f2a9e-...","view":"back","mimeType":"image/jpeg","width":896,"height":1200,"image":"data:image/jpeg;base64,/9j/4AAQ..."}

data: {"type":"done","jobId":"6c1f2a9e-...","status":"ok","views":["front","back"]}
```

Example 2 sends one `image` (`"view":"front"`) and `"views":["front"]`; example 3 one `image`
(`"view":"back"`) and `"views":["back"]`.

### Presentations: a model, a mannequin, or a sketch

The same designs and fabrics can be shown three ways. Leave `presentation` out and nothing changes: the
garment is photographed on a person, exactly as before this option existed (12 October 2026).

| `presentation` | What comes back | Image calls |
| :--- | :--- | :--- |
| `model` (default) | Photographs on a person, front and back | 2 |
| `mannequin` | The same garment on a headless dress-form mannequin on a stand, front and back, plain studio | 2 |
| `sketch` | **One** fashion-illustration sheet: soft watercolour and ink on white paper, the front and back figures side by side, with hand-lettered labels pointing to the designed parts | 1 |

The value is not case-sensitive, and the usual spellings are understood: `maniquine`, `manikin`,
`dress-form` and `dummy` mean `mannequin`; `illustration`, `drawing` and `croquis` mean `sketch`.
Anything else is a `400` on the field `presentation`.

**Mannequin.** The garment is dressed on the form the way a good store dresses it - saree, lehenga and
dupatta drapes pinned in place - with no head, face, hands or person anywhere. Front and back work as for
the model: the back photograph is made from the front one, with the mannequin turned round. A blouse is
shown on a bust form, waist-up. `modelGender` chooses a female or male form. A photograph checker makes
sure no person appears and that front and back show the same mannequin.

**Sketch.** One sheet in one image call, so it costs half of a front-and-back photograph. `views` decides
the figures on the sheet: both (the default), or one. The image arrives as one `image` event with
`view: "sheet"`, the `views` on it, and `annotations` - the exact words of every label:

```json
{ "type": "image", "jobId": "6c1f...", "view": "sheet", "views": ["front", "back"],
  "annotations": [
    { "part": "PALLU",     "label": "Pallu: gold zari paisleys",       "on": ["front", "back"] },
    { "part": "BORDER",    "label": "Border: peacocks and temple",     "on": ["front", "back"] },
    { "part": "FABRIC",    "label": "Fabric: teal Banarasi silk",      "on": ["front", "back"] },
    { "part": "WORN_WITH", "label": "Worn with: plain blouse",         "on": ["front"] }
  ],
  "mimeType": "image/jpeg", "width": 896, "height": 1200, "image": "data:image/jpeg;base64,/9j/4AAQ..." }
```

The labels are written by the service, never invented by the image model: one per design area (its name
and a few words of what the reference shows), one for the main fabric, one for what the garment is worn
with - at most 8, at most 40 characters each, plain letters. `on` says which figure the label belongs to:
a `BACK` design only on the back figure, `FRONT`, `NECK`, `BUTTON`, `POCKET` and a saree's `PLEAT` only on
the front one. An image model can misspell hand lettering; `annotations` always has the exact words, so
show them as text in your app if a word on the drawing comes out wrong.

Each label is drawn once. A sheet with both figures also carries one small caption under each figure,
"FRONT" and "BACK"; there is no other text on it.

A `BACK` design on a sketch is first cut down to the part it is for (one small vision call that finds the
back bodice in the picture), because the back figure is drawn in the same call as the front and a
whole-garment picture would otherwise spread its skirt motifs onto the back of the drawing.

`modelImage` dresses a real person, so it only goes with `model`: with `mannequin` or `sketch` it is a `400`
(`PRESENTATION_CONFLICT` on `modelImage`). With `mannequin` or `sketch`, `start` and `done` also carry
`presentation`.

#### Verified on 12 October 2026

References from the live Design Discovery endpoint, the clearest of the first four results for each design.

| Request | Result |
| :--- | :--- |
| Mannequin - saree (`PALLU`, `BORDER`) | Headless dress form on a stand, no person; the same saree front and back; the border round the hem; the pallu hanging straight down, front and back. Before the fix: with no arm to rest on, the pallu stuck out sideways in mid-air. 56-73 s. |
| Mannequin - blouse (`NECK`) | A bust form, waist-up; the zardozi neckline on the front only, a plain back. 40 s. |
| Mannequin - lehenga (`SKIRT`) | The skirt design all the way round, a tie-up choli back, the dupatta down the left side. 48 s. |
| Sketch - saree (`PALLU`, `BORDER`) | Watercolour and ink, front and back figures, the pallu in front on the front figure and down the back on the back figure; every label spelled exactly and drawn once, one caption per figure. Before the fix: labels were drawn beside both figures and "FRONT"/"BACK" twice. 25-32 s, one image call. |
| Sketch - anarkali (`FLARE`, `BACK`) | The floral flare on both figures, the dori tie-up with tassels on the back figure only. 19 s. |
| Sketch - gown (`SKIRT_FLARE`, `BACK`) | Correct: the keyhole back and its leaves on the back bodice only, the back of the skirt as plain as the front. The `BACK` picture was a whole gown with leaves on its skirt. Before the fix (cropping the `BACK` picture to the bodice) those leaves and the picture's colour spread onto the back of the skirt. 29 s. |

**Good to know about `sketch`:**
- Lettering is drawn by the image model. Every word was spelled right in the tests, but `annotations` is the
  reliable copy.
- With no `fabrics`, the drawing takes its colours from the design pictures. Send a fabric to fix the colour.

#### Example requests

**Mannequin - a lehenga, front and back:**

```json
{
  "clientId": "acme-retail",
  "garment": "LEHANGA",
  "presentation": "mannequin",
  "designs": [
    { "area": "SKIRT",  "image": "https://res.cloudinary.com/acme/image/upload/v1/designs/lehenga-skirt.jpg" },
    { "area": "BORDER", "image": "https://res.cloudinary.com/acme/image/upload/v1/designs/lehenga-hem.jpg" }
  ]
}
```

**Sketch - a saree, both figures on one sheet:**

```json
{
  "clientId": "acme-retail",
  "garment": "SAREE",
  "presentation": "sketch",
  "designs": [
    { "area": "PALLU",  "image": "https://res.cloudinary.com/acme/image/upload/v1/designs/pallu-paisley.jpg" },
    { "area": "BORDER", "image": "https://res.cloudinary.com/acme/image/upload/v1/designs/border-peacock.jpg" }
  ],
  "fabrics": [ { "image": "https://res.cloudinary.com/acme/image/upload/v1/fabrics/teal-silk.jpg", "name": "Banarasi silk", "color": "teal" } ]
}
```

**Sketch - the back only, one figure:**

```json
{
  "clientId": "acme-retail",
  "garment": "BLOUSE",
  "presentation": "sketch",
  "views": ["back"],
  "designs": [ { "area": "BACK", "image": "https://res.cloudinary.com/acme/image/upload/v1/designs/keyhole-back.jpg" } ]
}
```

### How a request is answered, in two steps

1. **The references are read.** A text model looks at every picture you sent and writes down what it
   actually contains — "temple (mandir) spires in gold zari on teal", "small multi-coloured floral
   butis, red, green, orange, white", "block print, matte".
2. **The garment is generated.** Those words go to the image model **alongside** your pictures.

Step 1 exists because pictures alone were not enough: a border full of temple motifs came back as
plain gold bands until the motifs were named in words. It never fails a request: if it cannot run,
generation carries on from the pictures alone.

Each request makes **one** photograph. The image model is not deterministic, so if a result is not
right, sending the same request again gives a new attempt. **Tip:** crop each design picture to the part
it is for (see *Getting the best results*) - a whole-outfit photo can carry that outfit's other
decoration into the new garment.

### What "exact" means

Designs and fabrics are treated as a **strict specification**: the same motifs, colours, spacing and
technique (zari, embroidery, print), placed only in their area, on the exact fabric colour and texture
you sent. Anything else in a reference picture — a person, a background, a watermark — is ignored.
You must have the rights to the designs and fabrics you send.

---

## Response: an event stream

A good request answers `200` with `Content-Type: text/event-stream`. Each event is one line starting
with `data: ` followed by JSON, then a blank line. Lines starting with `:` are keep-alive pings sent
every 10 seconds while the photograph is being made; ignore them.

**Anything wrong with the request is refused before the stream opens**, as ordinary JSON (see
*Errors*). So check the status first: only `200` is a stream.

The stream carries **only the photograph** and the few fields needed to receive it:

| `type` | When | Contents |
| :--- | :--- | :--- |
| `start` | Immediately | `jobId` |
| `image` | On success, once per photograph | `view` (`"front"` or `"back"`), `image` (a `data:image/jpeg;base64,...` URI), `mimeType`, `width`, `height` |
| `done` | After the last `image` | `jobId`, `status: "ok"`, `views` (the photographs made, in order) |
| `error` | Instead of `image` | `jobId`, `code`, `message`, `retryable`, and `details` when the code has them (`GENERATION_BLOCKED`: `details.reason`; `IMAGE_UNUSABLE`: which images failed). `message` is always our own sentence, never the image model's wording. |

Every stream ends with either the `image` events + `done`, or `error`. Nothing else is sent: how the references
were read, how the photograph was checked and how long each step took stay in the service's own logs.

Measured in production: **30–45 seconds** for one photograph, **55–80 seconds** for a front-and-back
pair (a blouse with front, back and sleeve designs: 69 seconds). A slow attempt is cut off at 100s and tried once more. Keep your client's timeout at **240 seconds** or more, and show your
user a progress indicator while the stream is open.

```text
data: {"type":"start","jobId":"6c1f…"}

: keepalive 1757934812345

: keepalive 1757934822345

data: {"type":"image","jobId":"6c1f…","view":"front","mimeType":"image/jpeg","width":896,"height":1200,"image":"data:image/jpeg;base64,/9j/4AAQ…"}

: keepalive 1757934842345

data: {"type":"image","jobId":"6c1f…","view":"back","mimeType":"image/jpeg","width":896,"height":1200,"image":"data:image/jpeg;base64,/9j/4AAQ…"}

data: {"type":"done","jobId":"6c1f…","status":"ok","views":["front","back"]}
```

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
  const result = {};
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
      if (event.type === 'image') result[event.view] = event;   // { front, back }
      if (event.type === 'error') throw Object.assign(new Error(event.message), event);
    }
  }
  return result;                                    // { front: { image, width, height }, back?: {...} }
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

Everything needed to build a valid request: the 12 garments with their design areas, default model
gender, `framing`, `views` (`["front"]` or `["front", "back"]`), the `presentations` (`model`, `mannequin`, `sketch`), and `pairedWith` (what each is worn with, and its default colour), the limits, and the accepted image sources and formats. Build your pickers from this rather than
hard-coding the lists.

---

## Errors

Before the stream (JSON body `{ "success": false, "error": { "code", "message", "retryable", "details" } }`):

| Status | `code` | Meaning |
| :--- | :--- | :--- |
| `400` | `VALIDATION_ERROR` | Something in the request is wrong. `details[]` names each `field` and a specific `code`: `UNKNOWN_GARMENT`, `UNKNOWN_DESIGN_AREA`, `DUPLICATE_DESIGN_AREA`, `MULTIPLE_MAIN_FABRICS`, `FABRIC_AREA_CONFLICT`, `FABRIC_ID_NOT_IMAGE`, `VIEW_NOT_AVAILABLE`, `IMAGE_SOURCE_NOT_ALLOWED`, `INSECURE_URL`, `INVALID_IMAGE_ENCODING`, `IMAGE_TOO_LARGE`, `INVALID_FIELD`. |
| `400` | `INVALID_JSON` | The body is not valid JSON. |
| `401` | — | Missing or wrong `x-api-key`. |
| `413` | `PAYLOAD_TOO_LARGE` | The request is over 50 MB. Send smaller images (a few MB each is plenty). |
| `422` | `IMAGE_UNUSABLE` | One or more images could not be used. `details[]` lists **every** failing image with its `field` and `code`: `IMAGE_NOT_FOUND`, `IMAGE_NOT_ACCESSIBLE`, `IMAGE_DOWNLOAD_FAILED`, `IMAGE_TOO_LARGE`, `IMAGE_TOO_SMALL`, `INVALID_IMAGE`, `UNSUPPORTED_IMAGE_FORMAT`, `IMAGE_SOURCE_NOT_ALLOWED`. |
| `429` | — | Busy, or your hourly generation allowance is used up. Wait for the `Retry-After` header (seconds) and retry. |
| `500`, `502`, `503`, `504` | `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`, `SERVICE_BUSY`, `GATEWAY_TIMEOUT` | A momentary failure in the gateway or on the way to the service (body `{ "error": { "code", "message" } }`). Nothing was generated. **Retry once** after 2 seconds with the same request. |

**A `200` that ends with no events at all** (the connection closed before `start`) is the same kind of
momentary failure: retry once.

Inside the stream (`error` event):

| `code` | Meaning | Retry? |
| :--- | :--- | :--- |
| `GENERATION_BLOCKED` | The image model declined these references (`details.reason`). | No — change the images. |
| `GENERATION_REJECTED` | The image model could not process this input. | No — change the request. |
| `NO_IMAGE_RETURNED` | The model answered without an image, even after a second try. | Yes |
| `MODEL_UNAVAILABLE` | The image model is busy or down (already retried for you). | Yes, shortly |
| `MODEL_TIMEOUT` | The image model did not answer in time, twice. Measured: normal runs take 25-60s, a rare one hangs. | Yes |
| `MODEL_QUOTA_EXCEEDED` | The image model has reached its spending cap or quota on this deployment. Every generation fails until it is raised. | No - tell your operator; retrying does not help |
| `CANCELLED` | You cancelled, or started a new generation with the same `clientId` - including a cancel that lands while a photograph is being checked. | — |
| `INTERNAL_ERROR` | Unexpected failure. | Yes |

---

## Getting the best results

- **Crop each design to the design itself** — a close-up of the pallu, not a whole person wearing a saree.
  A photo of a whole garment still works: **only the named part is used**. A `SLEEVE` design taken from
  a photo of a printed kurti gives the sleeve alone — not that kurti's neckline or print — and nothing
  from the person in the photo (hair flowers, jewellery) is copied. A close-up, flat swatch, trim or
  artwork is used whole as that part's design.
- **Keep each note consistent with its picture.** The picture decides the design, but a note that
  describes something different can still pull that part toward the note. Measured: a border note
  saying "gold zari temple border" on a picture of dahlias gave a gold zari border; the same request
  with no notes gave the dahlia border exactly.
- **One clear design per area.** Six sharp references beat ten blurry ones.
- **Photograph fabrics flat, in daylight**, filling the frame, so the colour and weave are true.
- **Name your fabrics** (`"Banarasi silk"`, `"georgette"`): it helps the model get the sheen and drape right.
- Use **`appliesTo`** when a fabric is only for part of the garment (a tissue pallu on a silk saree).
- Reuse the same **`modelImage`** across a collection for a consistent look.
- Use **`groundColorHex`** whenever a design photo is shot on a different colour than your product.

### Known limits, measured

- **A busy fabric can out-shout a design.** If a fabric swatch is itself a dense brocade or jaal and
  the same part also has a design reference, the fabric's woven pattern tends to dominate that part.
  Send a plain fabric for a part that has its own design. Verified both ways on the same saree: with a brocade jaal on the body, the body design's
  multi-coloured butis disappeared; with a plain wine silk on the body, they came through exactly.
- **Very fine motifs are approximate.** Large areas, drape, fabric colour and texture are dependable;
  a tiny repeated motif may be simplified. Naming it in `designs[].note` helps.
- **Send a close-up for an edge.** A `BORDER`, hem, cuff or waistband design is always made as a band
  along that edge. If its picture is a whole garment patterned all over, it is still used only as a
  band - a close-up of the band itself gives a closer match.
- **Embellishment shapes are approximate.** Measured: small cone tassels came back as round latkans
  with pearls, and a feathered gota fringe as a flat scalloped band. The placement and colours were
  right; the exact shape of a small 3D trim is the least reliable detail.
- **Send a design for every part you want decorated.** Parts without a design of their own stay plain
  in your fabric: without a `SLEEVE` design the sleeves are plain, even when a `NECK` or `FRONT` photo
  shows embroidered sleeves or cuffs. For decorated sleeves, send a `SLEEVE` design.
- **A trim that is the design is kept.** A `WAISTBAND` photo whose waistband is a pearl-and-tassel
  fringe gives a fringed waistband; tassels are only removed where they are not the named part (the
  ends of a dupatta photographed whole, a saree pallu).
- **One photograph shows one side.** Every garment is photographed from both sides by default (see
  *Front and back*); with `views` set to one side, the other side's designs are not shown.
