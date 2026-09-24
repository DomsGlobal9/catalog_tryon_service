# Plan: colour variants for the women's catalog (one saree, many colours)

Status: **built on 24 September 2026.** First written on 15 September 2026, revised the same day it was built with the review notes (structured `color` field, preserve and do-not lists, the zari safeguard, and an honest accuracy field in the response). The caller-facing description is in `API_DOCUMENTATION.md` under *Colour variants*; this file keeps the reasoning.

**What the one paid run showed (24 September 2026):** green-and-gold silk saree → Royal Blue `#2745A8`, 107 s for four views. The body recoloured evenly, the gold zari stayed gold, the motifs kept their layout, and the three other views matched the front. The blouse and the border's selvedge band also turned blue although told to stay. The rule was reworded to name the forbidden outcome ("the blouse must NOT become Royal Blue") in the colour rule, in the negatives and in the blouse paragraph. A second paid run after the rewording (red Banarasi with a gold brocade blouse → Emerald Green `#0B6E4F`, 28 s) came out right: saree green, blouse still red-and-gold, border and zari still gold, motifs unchanged.

## What you asked

The women's catalog endpoint makes photos only in the colour of the saree you upload. A product usually comes in several colours. You want to pass a colour and get the same saree, same design, in that colour.

## The idea in one line

Treat a colour variant as a **controlled recolouring**, not as a new saree-generation flow. The pipeline stays as it is. One step changes the colour of the front photo, and every other view is made from that recoloured front.

```text
Original saree
     ↓
Front view, made in the requested colour
     ↓
Back / side / sitting, made from that front (as today)
     ↓
Catalog result
```

## The one rule that fights this

The strongest rule in today's prompt is:

> EXACT COLOUR. Match the hue, saturation and tone of the reference precisely.

That rule is why the catalogs look faithful. A colour variant contradicts it on purpose. So the job is to carve out **one precise exception** without loosening anything else.

## Why it is cheap: one source of truth

The front view is made first. The back, side and sitting views are made **from the finished front photo**, and the original flat-lay is hidden from them (`inputSlots.hasFullDress = false` in `catalogAiService.js`). So we recolour the front only, and the other three views inherit the new colour for free. Do **not** add colour instructions to the other three views separately. One recoloured front is the single source of truth, so the four views cannot disagree on the colour.

## The honest limit, read before deciding

An image model cannot hit an exact hex code. Ask for `#0F5132` and you get *a* deep green. It will be close, and it will differ a little between runs. That is fine for "show me this saree in bottle green". It is **not** fine if a product page claims "this is exactly #0F5132" and a customer compares it with the cloth.

So the product wording should say **"Bottle Green" / "colour variant"**, never "exact #0F5132 reproduction". The API says the same thing by returning `colorAccuracy: "approximate"` (see section 5).

Hex codes also mean little to the model. "Deep bottle green" is much stronger input than `#0F5132`. The prompt sends both: the name as the instruction, the hex as a reference.

## The plan

### 1. API: one optional `color` object, one colour per request

Add one optional field to `POST /api/v1/draping/generate-catalog/women`:

```json
{
  "clientId": "...",
  "modelId": "saree1",
  "saree": "...",
  "color": { "name": "Bottle Green", "hex": "#0F5132" }
}
```

- `color.name` is the plain colour name the model is told to make.
- `color.hex` is optional and is passed as a colour reference.
- If only `hex` is given, the service maps it to the nearest named colour (the `colours.js` table from Design Studio already does this) and uses that name.
- A plain string is also accepted as a shortcut: `"color": "Bottle Green"` or `"color": "#0F5132"`.
- Leave `color` out and behaviour is **exactly today's**. Nothing else in the request changes.

Why one colour per request, not a list: the gateway cuts requests off at 90 seconds, and one four-view catalog takes 27 to 70 seconds. Three colours in one request would time out and lose the whole batch. The caller loops instead, with a **different `clientId` per colour**, because the same `clientId` cancels the previous job.

### 2. Prompt: swap one clause, keep the rest

When `color` is present, the EXACT COLOUR clause is replaced by a recolour block. Every other fidelity rule stays: exact scale, exact placement, continuous borders, nothing added or removed.

The recolour block, roughly:

```text
TARGET COLOUR: Bottle Green (colour reference #0F5132).

Recolour ONLY the saree's base fabric to a deep bottle-green tone that
visually matches the supplied colour reference. The requested colour is
the ONLY intended difference from the reference saree.

Preserve exactly: the saree's design, embroidery, motifs, borders, zari,
weave, fabric texture, folds, drape, transparency, highlights and shadows.

Do NOT: redesign the saree, change the pattern, change the border, change
the embroidery or zari, alter the blouse, change the model, pose or
background, add accessories, or remove details.
```

### 3. The safeguard: recolour the base cloth, not the whole picture

The common failure with "make it red" is that the gold zari turns reddish-gold and the embroidery shifts colour with it. So the prompt names what changes and what does not, part by part:

```text
Base fabric      → Bottle Green
Gold / silver zari → unchanged (stays metallic)
Embroidery       → unchanged
Prints / motifs  → unchanged
Border           → unchanged, unless the caller includes it (see below)
Blouse           → unchanged, unless the caller includes it (see below)
```

Two optional switches on the `color` object, both default `false`:

- `color.border: true` recolours the border along with the body.
- `color.blouse: true` recolours the blouse along with the saree.

Defaults follow real sarees: zari stays gold, the border and the blouse keep their own colour.

### 4. A consistency bug this will expose

The background is chosen at random on every generation (`randomEnv` in `catalogAiService.js`). So the red variant and the green variant of the same saree would land in different rooms, which is useless as a product-page set. When `color` is present, the plan pins the environment so a variant set matches.

### 5. Response: say what was asked for, and that it is approximate

The stream's `start` event (and the final result) carries:

```json
{
  "requestedColor": "#0F5132",
  "colorName": "Bottle Green",
  "colorAccuracy": "approximate"
}
```

There is no `exactHexMatch` flag, because model-made pixels cannot guarantee it. Callers can show "Bottle Green" and store the hex for their own catalogue.

### 6. Two ways to do the front, pick one

- **A. Recolour while draping (one image call, recommended first).** The front is made from the original flat-lay with the recolour block in the prompt. Same cost as today: 4 image calls per variant.
- **B. Recolour as a separate edit pass (one extra call).** The front is made as today, then a second image call recolours that finished photo, then the other views follow. Edit passes hold design detail very well, so this is the fallback if A leaks colour into the zari or drifts the motifs. Cost: 5 image calls per variant.

Build A behind a config switch so B can be turned on without a code change if the live check in section 8 shows leaks.

### 7. Files touched

| File | Change |
|---|---|
| `src/routes/catalogRoutes.js` | Accept and validate `color` (object or string, hex format, name length) |
| `src/services/catalogAiService.js` | Pass it into the front prompt; pin the environment; add the response fields; optional edit pass (B) |
| `src/config/sys-constants-catalog.js` | The conditional recolour block and the part-by-part safeguard |
| `src/services/designstudio/colours.js` | Reuse the named-colour table for hex to name |
| `API_DOCUMENTATION.md` | Document the field, the switches, and the "approximate" caveat |
| `tests/run.js` | New checks |

The men's pipeline is out of scope. It has its own prompt file.

### 8. How we prove it works

- **Offline:** with no `color`, the generated prompt is byte-identical to today's. That is the regression guarantee.
- **Offline:** hex validation, hex to name mapping, the block appearing only when asked, zari and blouse lines present by default, border and blouse lines switching with the flags, environment pinned.
- **Live, once:** the same saree in three colours, checked by eye. Colour changed; motifs, borders, zari and blouse did not; same background in all three.

## What we would not do

Recolouring the flat-lay in code (shifting hue mathematically before sending it) gives exact colours, but it shifts the gold zari and silk sheen too and looks cheap. Only worth revisiting if exact colours become a must.

## Decisions taken in this revision

1. Zari stays gold by default. Not switchable.
2. The border and the blouse keep their own colour by default. Switchable per request.
3. Colour accuracy is stated as approximate in the API and in product wording.

## Still open

- Confirm "close to the colour" is acceptable for your product pages. If an exact shade is required, this approach is the wrong tool.
- Confirm option A first, with B as the switchable fallback.
