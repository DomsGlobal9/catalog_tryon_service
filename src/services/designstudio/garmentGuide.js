// =============================================================================
// garmentGuide.js — what a garment IS, how it is worn, and where each design goes.
// =============================================================================
//
// The garment and design-area ids are the platform taxonomy (the same ids a
// third party gets from discovery). This file adds what an image model needs
// and a taxonomy does not have:
//
//   outfit     what the finished outfit consists of, so a "PALLU" design lands
//              on a correctly constructed saree rather than a vague drape
//   styling    footwear, jewellery and other finishing touches
//   pairedWith the supporting pieces a real photograph needs but that are NOT the
//              product (a saree needs a blouse; a blouse needs a saree). They
//              never carry a design. null when the product is the whole outfit.
//              colour: match | coordinate | contrast - the default when the
//              caller sends no pairWith colour.
//   framing    full | three-quarter | waist-up. How much of the model is in the
//              photograph. Chosen so the PRODUCT fills the frame while every
//              part of it stays inside: a blouse ends at the waist, so a
//              full-length shot made it a small strip above a saree; a
//              dupatta's ends and tassels hang to the knees, so waist-up would
//              cut them off. Everything full-length by default.
//   pose       a pose that actually shows the product's key parts
//   areas      for every design area: exactly where on the garment it goes
//
// Every (garment, area) pair in the taxonomy must resolve here; the test suite
// enforces it, so adding an area to the taxonomy without describing it fails CI.
//
const taxonomy = require('../../modules/discovery/taxonomy');

// Areas that are a finish or a master pattern rather than a place on the body.
// A place-specific reference always wins inside its own place.
const GLOBAL_AREAS = new Set(['OVERALL', 'PRINT', 'EMBROIDERY', 'ZARI_WORK', 'PRINT_PATTERN']);

// Areas that can only be seen from behind.
const BACK_AREAS = new Set(['BACK']);

const COMMON_AREAS = {
  OVERALL: (g) => `the complete design of the whole ${g.product}. Use it as the master reference for every part of the garment that has no more specific design reference of its own`,
  FRONT: (g) => `the front of the ${g.top}: the front panel design, from the neckline down to the hem`,
  BACK: (g) => `the back of the ${g.top}: back neck shape, back panel design and any tie-ups or latkans. This must be clearly visible in the photograph`,
  NECK: (g) => `the neckline of the ${g.top}: its exact cut and depth, and its piping, lace or embellishment`,
  SLEEVE: (g) => `the sleeves of the ${g.top}: their exact length, cut and design, including any sleeve border`,
  SIDE: (g) => `the sides of the ${g.top}: side seams, side panels and slits, with their piping or detailing`,
  BORDER: (g) => `the borders of the ${g.product}: the decorative bands along its edges. Keep the band's width in the same proportion to the garment as in the reference`,
  BODY: (g) => `the main body of the ${g.product}: the large field of fabric between the borders. Repeat its motifs at the reference's size and spacing`,
  PRINT: (g) => `the printed pattern. Apply it as the all-over print on the ${g.product} at the reference's scale, except on any part that has its own design reference`,
  EMBROIDERY: (g) => `the embroidery. Reproduce the same needlework (stitch type, thread colours, motif shapes and density) where embellishment belongs on the ${g.product}, except on any part that has its own design reference`,
  POCKET: (g) => `the pockets of the ${g.top}: their position, shape, flap and detailing`,
  WAIST: (g) => `the waist of the ${g.product}: the waistband or waist seam and its detailing`,
  FLARE: (g) => `the flare of the ${g.product}: its fullness, the number and colour of its panels (kalis), and the design on them`,
  DUPATTA: () => 'a dupatta carrying this design, draped over one shoulder and falling in front so its design is clearly visible without hiding the garment'
};

const GUIDE = {
  SAREE: {
    wearer: 'female',
    product: 'saree',
    top: 'saree',
    outfit: 'A complete six-yard saree worn over a fitted blouse, with the petticoat hidden underneath.',
    construction: [
      'Drape it in the classic Nivi style.',
      'Make 7 to 9 crisp, evenly spaced front pleats tucked at the navel and falling straight to the ankles, so the border runs down the edge of every pleat and along the hem.',
      // Measured: asking for the pallu over the shoulder AND forward over the
      // forearm produced TWO pallus, one on each arm. One sentence, one pallu.
      'The saree has exactly ONE pallu: a single continuous length that crosses the chest, passes over the LEFT shoulder and hangs down the front of the left side, fully open and facing the camera so all of its design is visible. Do not show a pallu on the right side, over the right arm, or anywhere twice.'
    ],
    // Measured: "plain unless a design reference describes it" let a pallu design
    // move onto the blouse. A saree has no blouse areas, so nothing describes it.
    styling: null,
    // Measured twice: a zari band from the saree border appeared at the sleeve ends.
    pairedWith: { pieces: 'blouse', plural: false, looks: 'a fitted, elbow-length blouse whose sleeves end in a plain, clean hem and whose neckline is plain, with no border band anywhere', colour: 'match' },
    poseHint: 'Both arms hang relaxed and clear of the pallu, so nothing covers it and no second drape appears.',
    areas: {
      // Measured: the pallu ended in a large panel of plain crimson with no design.
      PALLU: 'the pallu: the loose decorated end of the saree, about the last metre, that falls from the left shoulder. Reproduce this design across the pallu\'s full width and its whole length, including its cross-bands and end border, right down to the pallu\'s lower edge. The pallu must never end in a large plain block of fabric',
      BORDER: 'the saree borders: the continuous bands along both long edges of the saree. They show along the hem at the feet, down the edge of every front pleat and along the edge of the pallu. Keep the band width in the same proportion to the saree as in the reference',
      BODY: 'the main body of the saree: the large field between the borders, seen on the pleats and wrapped around the hips. Repeat its motifs (buttis) at the reference\'s size and spacing',
      PLEAT: 'the front pleats: the folded panel tucked at the waist. Show this design on the pleat faces so it reads correctly as the pleats fan out',
      ZARI_WORK: 'the zari work: woven metallic gold or silver thread work. Reproduce the same motifs and metallic tone with a real woven metallic sheen on the border and pallu, except where those have their own design reference'
    }
  },

  BLOUSE: {
    wearer: 'female',
    product: 'blouse',
    top: 'blouse',
    outfit: 'A fitted saree blouse (choli). The blouse is the product.',
    construction: [
      'Give the blouse a precise tailored fit with clean darts and seams.',
      'No saree, no pallu, no dupatta and no drape of any kind: nothing crosses or covers any part of the blouse.'
    ],
    styling: null,
    // Measured: with a saree, its pallu hid a third of the blouse front even when
    // told to pin it back, and the blouse was a small strip in a full-length shot.
    framing: 'waist-up',
    pairedWith: { pieces: 'skirt', plural: false, looks: 'a plain, high-waisted, floor-length skirt, of which only the waistband and a few centimetres below it are in the frame', colour: 'contrast' },
    poseHint: 'Arms are relaxed and held slightly away from the body so the sleeves and sides of the blouse are fully visible.',
    areas: {
      HAND: 'the sleeve ends of the blouse: the cuff, sleeve hem or armhole finishing and its detailing'
    }
  },

  DUPATTA: {
    wearer: 'female',
    product: 'dupatta',
    top: 'dupatta',
    outfit: 'A full-length dupatta. The dupatta is the product.',
    construction: [
      // Measured on 3 of 4 real dupattas: with one end in front and the other off to
      // the side, the two ends came out different (gold brocade vs red on red; a
      // zigzag end vs a floral panel). Both ends now hang in front, side by side,
      // where a mismatch cannot hide.
      'Drape the dupatta around the back of the neck so that BOTH long ends hang straight down the front of the body, one over each shoulder, side by side and at the same height, each opened out flat so its body, borders and decorated end are clearly visible.',
      'A dupatta\'s two ends are identical: the same end design in the same colours and metallic finish, and the same tassels where it has them. The two ends hanging side by side are mirror images of each other.'
    ],
    styling: null,
    // Full length. Not waist-up: its ends and tassels hang to about the knee. And
    // not three-quarter either - measured on four real dupattas, the image model
    // framed three of them head to toe even when told the feet are out of frame.
    // The whole dupatta is visible either way; promising a crop it does not
    // reliably deliver would be the worse contract.
    framing: 'full',
    pairedWith: { pieces: 'kurta', plural: false, looks: 'a simple, solid, matte straight kurta with no drape, border or embellishment of its own, worn with slim matching churidar', colour: 'contrast' },
    poseHint: 'Standing straight and square to the camera, arms relaxed at the sides and clear of the dupatta, so both hanging ends are fully visible.',
    areas: {
      BORDER: 'the dupatta borders: the bands along its two long edges',
      PALLU_END: 'the two short decorated ends of the dupatta (the pallu ends), including their cross-bands. Both ends carry this same design in the same colours and the same metallic finish',
      BODY: 'the main body of the dupatta: the field between the borders, with motifs at the reference\'s size and spacing',
      CORNER: 'the four corners of the dupatta, where the borders meet: the corner motif',
      TASSEL: 'the tassels (latkans) hanging from both dupatta ends: copy their shape, beads, colours, length and spacing, identical on both ends'
    }
  },

  KURTHI: {
    wearer: 'female',
    product: 'kurti',
    top: 'kurti',
    outfit: 'A knee-length kurti. The kurti is the product.',
    construction: ['Tailor it with a flattering straight or A-line fall, with side slits unless a design reference shows otherwise.'],
    styling: 'Simple flat footwear. No dupatta.',
    pairedWith: { pieces: 'churidar', plural: false, looks: 'slim churidar or leggings', colour: 'coordinate' },
    poseHint: 'Arms are relaxed slightly away from the body so the sides and sleeves are visible.',
    areas: {
      HEMLINE: 'the bottom hem of the kurti: the hem band and its border or scalloping'
    }
  },

  ANARKALI: {
    wearer: 'female',
    product: 'Anarkali',
    top: 'Anarkali',
    outfit: 'A floor-length Anarkali suit with a fitted bodice, a high waist seam just under the bust, and a full flared skirt made of many panels (kalis), worn with a matching churidar.',
    construction: ['Let the flare fall in rich, even folds to the floor, with the hem border running all the way round.'],
    styling: 'Footwear is simple and barely visible under the flare.',
    pairedWith: { pieces: 'churidar', plural: false, looks: 'a fitted churidar', colour: 'match' },
    poseHint: 'One hand lightly lifts the side of the flare so the panels open out and show their design.',
    areas: {
      FLARE: 'the flared skirt below the waist seam: the number, colour blocking and design of its panels (kalis)',
      BORDER: 'the hem border: the wide decorative band around the bottom of the flare',
      WAIST_BELT: 'the waist seam band just under the bust, or the belt worn there'
    }
  },

  PETTICOAT: {
    wearer: 'female',
    product: 'petticoat',
    top: 'petticoat',
    outfit: 'A saree petticoat (inskirt) shown as the product itself: a floor-length, flared skirt with a drawstring waist.',
    construction: ['Show it on its own with no saree over it, so the whole petticoat is visible.'],
    styling: null,
    pairedWith: { pieces: 'blouse', plural: false, looks: 'a short, fitted blouse ending at the waist so the waistband shows', colour: 'contrast' },
    poseHint: 'Arms are relaxed at the sides, clear of the waistband.',
    areas: {
      WAIST: 'the waistband of the petticoat: its drawstring casing and detailing',
      FLARE: 'the petticoat\'s panels and flare: their number, cut and fullness',
      BOTTOM_BORDER: 'the bottom border of the petticoat: the hem band, frill or lace at the bottom',
      SIDE: 'the side placket or slit of the petticoat and its finishing'
    }
  },

  GOWN: {
    wearer: 'female',
    product: 'gown',
    top: 'gown',
    outfit: 'A floor-length ethnic gown. The gown is the product.',
    construction: ['Give it a fitted bodice and a skirt that falls to the floor with graceful volume.'],
    styling: 'Footwear is simple and mostly hidden. Jewellery is minimal.',
    pairedWith: null, // the product is the whole outfit
    poseHint: 'One hand lightly holds the skirt so its flare and hem are visible.',
    areas: {
      SKIRT_FLARE: 'the skirt of the gown from the waist to the floor, including any train: its fullness, panels and design',
      BORDER_HEM: 'the hem border of the gown: the decorative band around the bottom of the skirt'
    }
  },

  SUIT: {
    wearer: 'female',
    product: 'salwar kameez',
    top: 'kameez',
    outfit: 'A salwar kameez: a long kameez (tunic) with matching bottoms (salwar, churidar or palazzo).',
    construction: ['Make the kameez and bottoms a coordinated set from the specified fabrics.'],
    styling: 'Footwear is simple flats.',
    pairedWith: null, // the product is the whole outfit
    poseHint: 'Arms are relaxed slightly away from the body so the kameez sides and sleeves are visible.',
    areas: {
      BOTTOM_SALWAR: 'the bottoms of the suit (salwar, churidar or palazzo): their exact cut, fullness and design, matching the reference',
      BORDER: 'the borders of the kameez: the bands along its hem and sleeve ends'
    }
  },

  SHERWANI: {
    wearer: 'male',
    product: 'sherwani',
    top: 'sherwani',
    outfit: 'A knee-length sherwani with a structured mandarin collar and a front button placket, worn with a fitted churidar.',
    construction: ['Tailor it sharply, with a clean shoulder line and a straight fall to the knee.'],
    styling: 'Plain mojari shoes. No stole unless a design reference asks for one.',
    pairedWith: { pieces: 'churidar', plural: false, looks: 'a fitted churidar', colour: 'coordinate' },
    poseHint: 'Standing upright, arms relaxed at the sides, clear of the buttons and pockets.',
    areas: {
      COLLAR_NECK: 'the collar of the sherwani: the mandarin (bandhgala) collar\'s height, shape and embellishment',
      BUTTON: 'the buttons down the front placket: their shape, material, colour, size and count',
      HEM_BOTTOM: 'the bottom hem of the sherwani and its border',
      PRINT_PATTERN: 'the print or woven pattern. Apply it across the sherwani at the reference\'s scale, except on any part that has its own design reference'
    }
  },

  BOTTOM_WEAR: {
    wearer: 'female',
    product: 'bottom wear',
    top: 'bottom wear',
    outfit: 'Ethnic bottom wear (palazzo, salwar, churidar, patiala or trousers, following the design references). The bottom wear is the product.',
    construction: ['Show the bottoms full length from the waist to the ankles, following the style and cut in the references.'],
    styling: null,
    pairedWith: { pieces: 'top', plural: false, looks: 'a short, fitted top that ends at the waist, so the waistband and the full length of the bottoms are visible', colour: 'contrast' },
    poseHint: 'Standing with the feet slightly apart so the full shape of each leg is visible.',
    areas: {
      WAIST: 'the waistband of the bottoms and its detailing',
      UPPER_THIGH: 'the upper part of the bottoms, from the hips to the thighs: its cut and design',
      LEG: 'the legs of the bottoms: their shape, width and design down the length',
      BOTTOM_ANKLE: 'the ankle end of the bottoms: the hem, cuff (mori) and its border',
      FLARE: 'the width and flare of the legs, and any panels or pleats that create it',
      BORDER: 'the bottom border band of the bottoms',
      POCKET: 'the pockets of the bottoms'
    }
  },

  LEHANGA: {
    wearer: 'female',
    product: 'lehenga',
    top: 'choli',
    outfit: 'A bridal-style lehenga choli: a full, floor-length flared lehenga skirt, a fitted short choli blouse and a dupatta.',
    construction: [
      'Let the skirt fall in rich, even folds with plenty of volume, with the hem border running all the way round.',
      'Pin the dupatta at the left shoulder and let it fall behind the arm, so it frames the outfit without hiding the skirt.'
    ],
    // Same loophole as the saree: no lehenga area covers the choli or the dupatta.
    styling: null,
    pairedWith: { pieces: 'choli and dupatta', plural: true, looks: 'a fitted short choli blouse and a light dupatta', colour: 'match' },
    poseHint: 'One hand lightly lifts the side of the skirt so its flare and border open out.',
    areas: {
      SKIRT: 'the lehenga skirt from the waist to the floor: its full flare, panels (kalis) and design',
      BORDER: 'the hem border of the lehenga: the decorative band running around the bottom of the skirt',
      WAISTBAND: 'the waistband of the lehenga skirt and its detailing'
    }
  },

  SHARARA: {
    wearer: 'female',
    product: 'sharara set',
    top: 'kurti',
    outfit: 'A sharara set: a short kurti ending at mid-thigh, over sharara pants that are fitted to the knee and then flare out dramatically to the floor.',
    construction: ['Make the knee seam of the sharara clearly visible, with the flare falling in wide folds.'],
    styling: 'Footwear is simple and mostly hidden by the flare.',
    pairedWith: null, // the product is the whole outfit
    poseHint: 'Standing with one foot slightly forward so the flare of the pants opens out.',
    areas: {
      FLARE_PANTS: 'the sharara pants: the knee seam and the wide flare below it, with its panels and design',
      HEM_BOTTOM: 'the bottom hem of the sharara pants and its border',
      BORDER: 'the borders of the set: the hem bands of the kurti and the sharara'
    }
  }
};

const FRAMINGS = new Set(['full', 'three-quarter', 'waist-up']);
for (const [id, guide] of Object.entries(GUIDE)) {
  if (guide.framing === undefined) guide.framing = 'full';
  if (!FRAMINGS.has(guide.framing)) throw new Error(`Unknown framing "${guide.framing}" for ${id}`);
}

function garmentGuide(garmentId) {
  const guide = GUIDE[garmentId];
  if (!guide) throw new Error(`No garment guide for ${garmentId}`);
  return guide;
}

/** Where a design area goes on this garment, as a phrase for the prompt. */
function describeArea(garmentId, areaId) {
  const g = garmentGuide(garmentId);
  if (g.areas[areaId]) return g.areas[areaId];
  if (COMMON_AREAS[areaId]) return COMMON_AREAS[areaId](g);
  throw new Error(`No placement description for ${garmentId}/${areaId}`);
}

module.exports = { garmentGuide, describeArea, GLOBAL_AREAS, BACK_AREAS, taxonomy, GUIDE };
