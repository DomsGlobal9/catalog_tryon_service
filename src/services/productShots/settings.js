// =============================================================================
// productShots/settings.js - the product shots and the places they are shot in.
// =============================================================================
//
// Owner, 26 Nov 2026: besides the three model views, every saree gets product photos with no
// model - like a shop's own photos: the folded saree and a styled table scene (a fan of pleats was
// tried and dropped the same day) - and
// "not the same backgrounds" for every product. So each shot picks its surface and props at random
// from its own list, every time. The saree is never changed; only what it lies on.

/** The product shots, in the order they are listed in the answer. The pleats fan was removed on 26 Nov (owner did not like the style). */
const SHOTS = [
  {
    id: 'folded',
    name: 'Folded',
    // 26 Nov paid run: folded, the body came out as a plain check grid with small squares instead of
    // the saree's ikat diamonds - folding hides the saree, so the model fell back on a generic
    // pattern. The top of the fold is now named as the saree's own body pattern, with the usual
    // wrong answers forbidden.
    scene: 'THE SHOT: the saree neatly folded into a flat rectangle the way a shop stacks it, seen from above at a slight angle. The top of the fold is the saree\'s BODY: it carries exactly the body pattern of the SAREE photo - the same motif type, size, colours and density, repeated across the whole top - never a check grid, stripes, scattered small buttis or plain cloth unless the SAREE photo\'s body is exactly that. The border runs along the folded edges, and a corner of the pallu is folded over the top so its design shows. A few loose props sit beside the fold, never on top of it. The folded saree is the centre of the picture.',
    places: [
      'on a round woven orange cane mat, with a few loose marigold flowers and green leaves beside it',
      'on a white marble slab, with a small brass diya and a few jasmine buds beside it',
      'on a dark walnut wooden board, with a sprig of tulsi leaves and a small brass bowl beside it',
      'on a cream raw-silk cloth, with a pink lotus flower and two green leaves beside it',
      'on a terracotta-tiled floor, with a small clay pot and scattered rose petals beside it',
      'on a light jute rug, with a string of jasmine flowers curled beside it',
      'on a soft grey stone surface, with dried palm leaves and a small brass lamp beside it'
    ]
  },
  {
    id: 'table',
    name: 'Table scene',
    scene: 'THE SHOT: a styled still-life on a table at eye level, three-quarter view. Part of the saree is draped loosely over the table edge so its pleats and border fall naturally, and the rest is folded on the table top with the pallu design showing. The props stand around the saree, never covering it. Warm, calm, premium; the saree is clearly the hero of the picture.',
    places: [
      'a dark carved wooden table, a tall brass oil lamp, a brass bowl of jasmine flowers and a pink lotus, a warm cream wall behind',
      'a light teak console table, a white ceramic vase with tuberose stems, a small brass urli with floating petals, a soft beige wall behind',
      'a rustic wooden bench, a terracotta pot with green banana leaves, a few marigold strings, a whitewashed wall behind',
      'a marble-topped side table, a silver bowl, a few white roses in a glass, a pale sage-green wall behind',
      'an antique rosewood chest, a pair of brass bells, a jasmine garland, a warm ochre wall behind',
      'a cane-weave table, a stack of two hardbound books, a small brass elephant, a potted fern, a soft grey wall behind'
    ]
  }
];

const SHOT_IDS = SHOTS.map((s) => s.id);

/** A random place for one shot. `random` is injectable so a test can pin it. */
function pickPlace(shot, random = Math.random) {
  return shot.places[Math.floor(random() * shot.places.length) % shot.places.length];
}

module.exports = { SHOTS, SHOT_IDS, pickPlace };
