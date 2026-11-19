// =============================================================================
// parts/describe.js — what each part means for a close-up, where it differs from the design areas.
// =============================================================================
//
// The design areas (garmentGuide / taxonomy) are written for /generate and Discovery: there a
// blouse's HAND is "the sleeve ends: the cuff, sleeve hem or armhole finishing", and live callers
// send designs for it with that meaning, so it stays.
//
// A boutique asking for the "hand design" close-up means the whole hand - the sleeve from the
// shoulder to where it ends, with all its design and the border at its end (owner, 19 Nov 2026:
// "it's just giving hand border, not full hand"). Here, and only here, it means that.

const { describeArea } = require('../garmentGuide');

const OVERRIDES = {
  BLOUSE: {
    HAND: 'the whole hand of the blouse (its sleeve, as boutiques say): from the shoulder seam down to where the sleeve ends, with all of its design and the border or cuff at its end - never the border alone'
  }
};

// Parts shown whole, from end to end (a sleeve from shoulder to cuff), so they may be longer than
// most cuts before they are trimmed to a section.
const WHOLE_PARTS = new Set(['HAND', 'SLEEVE']);

/** Where the part is and what it covers, in one sentence, for the finder and the image model. */
function partWhere(garmentId, areaId) {
  return (OVERRIDES[garmentId] && OVERRIDES[garmentId][areaId]) || describeArea(garmentId, areaId).split(/\.\s/)[0];
}

module.exports = { partWhere, WHOLE_PARTS, OVERRIDES };
