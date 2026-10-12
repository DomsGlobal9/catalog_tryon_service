# Plan: Design Studio presentations — model, mannequin, sketch

Status: **plan only** (12 October 2026). Nothing below is built yet.

Today `POST /api/v1/designstudio/generate` turns design references and fabrics into catalogue
photographs of the garment **on a person**. This adds two more ways to show the same garment:

| `presentation` | What comes back | Image calls |
| :--- | :--- | :--- |
| `model` (default) | Photographs on a person, front and back - **exactly as today** | 2 |
| `mannequin` | The same garment on a headless dress-form mannequin, front and back, plain studio | 2 |
| `sketch` | One fashion-illustration sheet: front and back figures side by side, with labels pointing to the designed parts (the style of a hand-drawn design presentation) | 1 |

## Decisions taken

1. **One endpoint, one new field** - not separate endpoints. All three take the same designs, fabrics,
   garment and views, and share image preparation, the describe step, cancel, budget and admission.
   Only the last step - how the garment is shown - differs. Separate endpoints would copy all of that.
2. Field name **`presentation`**: `"model"` | `"mannequin"` | `"sketch"`, case-insensitive.
   **Absent means `model`**, so every existing caller gets exactly what they get today.
3. **Sketch = one sheet** with the front and back figures side by side (half the cost of two images).
4. **Sketch labels are drawn on the sheet AND returned as JSON** (`annotations`), so a caller can show
   them as real text if the image model misspells a word.

## API

### Request

```json
{
  "clientId": "acme-retail",
  "garment": "SAREE",
  "presentation": "sketch",
  "designs": [
    { "area": "PALLU",  "image": "https://res.cloudinary.com/acme/image/upload/v1/designs/pallu.jpg" },
    { "area": "BORDER", "image": "https://res.cloudinary.com/acme/image/upload/v1/designs/border.jpg" }
  ],
  "fabrics": [ { "image": "https://res.cloudinary.com/acme/image/upload/v1/fabrics/silk.jpg", "name": "Banarasi silk", "color": "teal" } ]
}
```

Validation (all refused as `400 VALIDATION_ERROR` before any paid call):

| Case | Answer |
| :--- | :--- |
| `presentation` not one of the three | `400`, field `presentation` |
| `presentation: "mannequin"` or `"sketch"` with `modelImage` | `400` - a reference person cannot be used on a mannequin or a sketch |
| `modelGender` with `mannequin` | allowed: chooses a female or male dress form (default: the garment's wearer) |
| `views` | as today. For `sketch` it decides the figures on the one sheet: both (default), front only, back only |

### Response (stream)

`model` and `mannequin`: unchanged - `start`, `image` (`view: "front"`), `image` (`view: "back"`), `done`.

`sketch`: one `image` event for the sheet:

```
data: {"type":"start","jobId":"6c1f...","presentation":"sketch"}

data: {"type":"image","jobId":"6c1f...","view":"sheet","views":["front","back"],"mimeType":"image/jpeg","width":896,"height":1200,
       "image":"data:image/jpeg;base64,/9j/4AAQ...",
       "annotations":[
         {"part":"PALLU","label":"Pallu: gold zari paisley","on":["front","back"]},
         {"part":"BORDER","label":"Border: peacock kanjivaram band","on":["front","back"]},
         {"part":"FABRIC","label":"Fabric: teal Banarasi silk","on":["front","back"]}
       ]}

data: {"type":"done","jobId":"6c1f...","status":"ok","presentation":"sketch","views":["front","back"]}
```

`annotations` is also in the default image-only stream (it is caller data, not debug detail).
`GET /options` gains `presentations: ["model","mannequin","sketch"]`.

## How each presentation is made (prompt changes, `promptBuilder.js`)

The garment sections (references, design rules, fabric rules, construction, what it is worn with)
are **shared and unchanged**. Only these parts switch on `presentation`:

| Prompt part | `model` | `mannequin` | `sketch` |
| :--- | :--- | :--- | :--- |
| TASK line | photograph of a woman wearing the garment | photograph of the garment dressed on a mannequin | fashion illustration sheet of the garment |
| THE MODEL | as today | a headless dress-form mannequin on a slim stand: neutral linen-coloured form, no face, no head, no wig, no arms unless the garment has sleeves (then soft fabric arms hidden inside the sleeves); female or male form | one slim, elegant fashion-illustration figure, the same woman drawn twice: front view on the left, back view on the right |
| Front-and-back | the back is made from the finished front photo (as today) | the same - the mannequin is turned round, same stand, same studio | both figures on one sheet in one call; no second image |
| Drapes (saree, lehenga dupatta, dupatta) | as today | the same drape, pinned on the form (normal in Indian retail) | the same drape drawn on both figures, the saree pallu falling down the back in the back figure |
| THE PHOTOGRAPH | studio photo, framing per garment | same studio; framing shows the whole form and the top of the stand; a blouse is waist-up on a bust form | soft watercolour and fine ink on white textured paper; both figures full length; generous margins for labels |
| Labels | none | none | the given label list, written in neat handwriting with thin leader lines to the parts - **exactly these words, no others**, no logos, no title |
| QUALITY BAR | as today | "photorealistic product photo", "exactly one mannequin, no person, no face" | "a hand-drawn illustration, not a photograph"; "exactly two figures of the same woman"; "every label spelled exactly as given" |

### The labels (sketch)

Built in code - never invented by the image model:

- One per design area: `"<Area name>: <short description>"`. The description comes from the describe
  step (motifs / technique, cut to about 5 words); without it, the area's own name and the caller's `note`.
- One for the main fabric: `"Fabric: <colour> <name or material>"`.
- One for the supporting piece when there is one: `"Worn with: <colour> <pieces>"`.
- At most 8 labels, 40 characters each, plain ASCII words (fewer misspellings).
- `on` says which figure the label belongs to: `BACK` → back only; `FRONT`, `NECK`, `PLEAT`... → front only;
  everything else → both (the same rule that decides which photo a design goes to today).

## Checks after the image (`qualityCheck.js`)

| Check | `model` | `mannequin` | `sketch` |
| :--- | :--- | :--- | :--- |
| Reference check (motifs, neckline, sheer) | as today | as today | off in v1 (a watercolour is not judged by photo rules) |
| Back vs front (same cloth and cut) | as today | as today, "same person" becomes "same mannequin"; "arms at the sides" dropped | not needed: one sheet |
| Regeneration on a failed check | as today | as today | none (1 call) |

## Cost and time

| | Image calls | Small checks | Expected time |
| :--- | :--- | :--- | :--- |
| `model` front + back | 2 (+ up to 2 retries) | describe + 2 | 40-150 s (measured) |
| `mannequin` front + back | 2 (+ up to 2 retries) | describe + 2 | about the same |
| `sketch` (one sheet) | 1 | describe | about 30-50 s |

## Nothing changes for existing callers - how that is proven

- Every prompt for `presentation: "model"` (and for no `presentation`) stays **byte for byte** the same:
  a fingerprint of the model prompts for all 12 garments x front/back is taken before the change and
  checked after it (the same technique used when colour variants were added to the catalog prompts).
- The existing 563 offline checks and the 62 end-to-end checks must all still pass unchanged.

## Build steps

1. `validate.js`: the `presentation` field, its aliases, the `modelImage` rule; `job.presentation`.
2. `promptBuilder.js`: the switches in the table above; label building for `sketch`.
3. `controller.js`: the sketch path (one image event with `view: "sheet"` and `annotations`);
   `presentation` echoed in `start` and `done`; `imageOnly` keeps `annotations`.
4. `qualityCheck.js`: mannequin wording; checks off for sketch.
5. `GET /options`: list the presentations.
6. Docs (`DESIGN_STUDIO_API.md`): a *Presentations* section with an example request and response for
   each; rebuild both PDFs.

## Testing

**Free first**
- Validation: every value, case, alias, `modelImage` with mannequin/sketch, `views` with sketch.
- Prompts: all 12 garments x 3 presentations x views - the right sections switched, labels built
  correctly (count, length, `on`), nothing from the model sections leaks into mannequin or sketch.
- The model-prompt fingerprint is unchanged.
- End-to-end on the real app with the free Gemini stand-in: each presentation's stream shape,
  `annotations` present in the image-only stream, cancel and hang-up still work.

**Then paid (about 9 image calls)**, references from Discovery as before:
- Mannequin: saree, blouse, lehenga - front and back each (6 calls). Look at: no head or face, the
  drape holds on the form, front and back are one garment.
- Sketch: saree, gown, anarkali - one sheet each (3 calls). Look at: watercolour look, two figures of
  the same garment, labels spelled right and pointing at the right parts, the back figure correct.

**Production, after Deploy:** the free checks again, then one paid call per new presentation.

## Risks, and what to do about them

| Risk | Plan |
| :--- | :--- |
| The image model misspells a label | Labels are short plain words; the exact text is also in `annotations`. If misspelling is common in the paid test, the fallback is a sketch with no text and labels drawn by the service itself (SVG overlay). |
| A saree on a mannequin looks stiff or the pallu sits oddly | Checked in the paid test; the drape lines can be tuned per garment as was done for the model. |
| The sketch comes out photo-like | The QUALITY BAR says "hand-drawn illustration, not a photograph"; the style lines are tested on 3 garments. |
| A mannequin with arms or a head appears | Named as forbidden in THE MODEL and the QUALITY BAR. |

## Later (not in this build)

1. **Technical flat** (`sketchStyle: "technical"`): clean black line drawing, front and back, no person -
   what tailors and factories use for production orders.
2. **Ghost mannequin**: the garment as if worn, with nothing inside it - the common e-commerce look.
3. **Transparent background** for mannequin photos, for shop banners.
4. **`annotations` for every presentation**, so an app can show "what is in this design" under any photo.
