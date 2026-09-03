// =============================================================================
// designTypes.js — The design areas discoverable within each garment.
// =============================================================================
//
// Keyed by garment id from garments.js. Together these drive the Manage Designs
// tree in the UI and the `designType` field on the search API.
//
// - `id`         canonical, unique within its garment
// - `name`       display label
// - `aliases`    lowercase forms the instruction parser matches ("pallu",
//                "aanchal", "saree end")
// - `queryTerms` what gets injected into the provider query. OVERALL is
//                deliberately empty: an overall search is just the garment.
//
// Note OVERALL exists for every garment, including the four where the original
// spec omitted it (Gown, Suit, Sherwani, and implicitly Petticoat), so the UI
// tree is uniform and "everything for this garment" is always addressable.
//
// ON "closeup" IN queryTerms
// Measured live: "saree border design" returned 0/5 component-focused images
// (whole-garment model shots), while "... closeup" returned 3/5, and lehenga
// border went 0/5 -> 2/5. "detail zoom" made it worse, so it is not used.
//
// It is added ONLY to areas where the component itself is the subject of the
// photograph - borders, pallus, embroidery, tassels, buttons, hems. It is
// deliberately absent from OVERALL, FRONT, BACK, SIDE, SLEEVE, FLARE, SKIRT and
// the dupatta-as-garment-piece areas, which are whole-garment views, and from
// NECK/COLLAR, which already returned 4/5 close-ups without it.
//
// This lives in the taxonomy data, never in the query builder: the builder just
// concatenates queryTerms and knows nothing about BORDER or PALLU.

const COMMON = {
  OVERALL:    { id: 'OVERALL',    name: 'Overall Design',        aliases: ['overall', 'full', 'complete', 'whole', 'entire'], queryTerms: [] },
  FRONT:      { id: 'FRONT',      name: 'Front Design',          aliases: ['front', 'front side'],                            queryTerms: ['front'] },
  BACK:       { id: 'BACK',       name: 'Back Design',           aliases: ['back', 'back side', 'rear'],                      queryTerms: ['back'] },
  NECK:       { id: 'NECK',       name: 'Neck Design',           aliases: ['neck', 'neckline', 'gala', 'collar'],             queryTerms: ['neck'] },
  SLEEVE:     { id: 'SLEEVE',     name: 'Sleeve Design',         aliases: ['sleeve', 'sleeves', 'baju'],                      queryTerms: ['sleeve'] },
  SIDE:       { id: 'SIDE',       name: 'Side Design',           aliases: ['side', 'side slit', 'slit'],                      queryTerms: ['side'] },
  BORDER:     { id: 'BORDER',     name: 'Border Design',         aliases: ['border', 'borders', 'edging', 'kinari'],          queryTerms: ['border', 'closeup'] },
  BODY:       { id: 'BODY',       name: 'Body Design',           aliases: ['body', 'main body'],                              queryTerms: ['body', 'closeup'] },
  PRINT:      { id: 'PRINT',      name: 'Print Design',          aliases: ['print', 'printed', 'pattern', 'motif'],           queryTerms: ['print', 'closeup'] },
  EMBROIDERY: { id: 'EMBROIDERY', name: 'Embroidery / Work Design', aliases: ['embroidery', 'embroidered', 'work', 'handwork', 'aari', 'zardosi'], queryTerms: ['embroidery', 'closeup'] },
  POCKET:     { id: 'POCKET',     name: 'Pocket Design',         aliases: ['pocket', 'pockets'],                              queryTerms: ['pocket', 'closeup'] },
  WAIST:      { id: 'WAIST',      name: 'Waist Design',          aliases: ['waist', 'waistline', 'kamar'],                    queryTerms: ['waist'] },
  FLARE:      { id: 'FLARE',      name: 'Flare / Ghera Design',  aliases: ['flare', 'ghera', 'flair', 'kali', 'godet'],       queryTerms: ['flare'] },
  DUPATTA:    { id: 'DUPATTA',    name: 'Dupatta Design',        aliases: ['dupatta', 'chunni', 'odhni'],                     queryTerms: ['dupatta'] }
};

const c = (key, overrides = {}) => Object.assign({}, COMMON[key], overrides);

const DESIGN_TYPES = {
  SAREE: [
    c('OVERALL', { name: 'Overall Saree Design' }),
    { id: 'PALLU',     name: 'Pallu Design',        aliases: ['pallu', 'palla', 'aanchal', 'anchal', 'saree end'], queryTerms: ['pallu', 'closeup'] },
    c('BORDER'),
    c('BODY'),
    { id: 'PLEAT',     name: 'Pleat Design',        aliases: ['pleat', 'pleats', 'plates', 'kucha'],               queryTerms: ['pleats', 'closeup'] },
    c('PRINT'),
    c('EMBROIDERY', { name: 'Embroidery Design' }),
    { id: 'ZARI_WORK', name: 'Zari / Work Design',  aliases: ['zari', 'zari work', 'jari', 'brocade', 'meenakari'], queryTerms: ['zari', 'work', 'closeup'] }
  ],

  BLOUSE: [
    c('OVERALL', { name: 'Overall Blouse Design' }),
    c('FRONT'),
    c('BACK'),
    c('NECK'),
    c('SLEEVE'),
    { id: 'HAND', name: 'Hand Design', aliases: ['hand', 'hand design', 'armhole', 'cuff'], queryTerms: ['hand'] }
  ],

  DUPATTA: [
    c('OVERALL', { name: 'Overall Dupatta Design' }),
    c('BORDER'),
    { id: 'PALLU_END', name: 'Pallu / End Design',   aliases: ['pallu', 'end', 'end design', 'aanchal'],        queryTerms: ['pallu', 'closeup'] },
    c('BODY'),
    { id: 'CORNER',    name: 'Corner Design',        aliases: ['corner', 'corners', 'kona'],                    queryTerms: ['corner', 'closeup'] },
    c('PRINT'),
    c('EMBROIDERY'),
    { id: 'TASSEL',    name: 'Tassel / Latkan Design', aliases: ['tassel', 'tassels', 'latkan', 'latkans', 'phundi'], queryTerms: ['tassel', 'latkan', 'closeup'] }
  ],

  KURTHI: [
    c('OVERALL', { name: 'Overall Kurti Design' }),
    c('FRONT'),
    c('BACK'),
    c('NECK'),
    c('SLEEVE'),
    { id: 'HEMLINE', name: 'Hemline / Bottom Design', aliases: ['hemline', 'hem', 'bottom', 'daman'], queryTerms: ['hemline', 'closeup'] },
    c('SIDE'),
    c('EMBROIDERY'),
    c('PRINT'),
    c('POCKET')
  ],

  ANARKALI: [
    c('OVERALL', { name: 'Overall Anarkali Design' }),
    c('FRONT'),
    c('BACK'),
    c('NECK'),
    c('SLEEVE'),
    c('FLARE'),
    c('BORDER'),
    c('DUPATTA'),
    c('EMBROIDERY', { name: 'Embroidery Design' }),
    c('PRINT'),
    { id: 'WAIST_BELT', name: 'Waist / Belt Design', aliases: ['waist', 'belt', 'kamarbandh', 'kamarband'], queryTerms: ['waist', 'belt', 'closeup'] }
  ],

  PETTICOAT: [
    c('OVERALL', { name: 'Overall Petticoat Design' }),
    c('WAIST'),
    c('FLARE'),
    { id: 'BOTTOM_BORDER', name: 'Bottom / Border Design', aliases: ['bottom', 'border', 'hem'], queryTerms: ['bottom', 'border', 'closeup'] },
    c('SIDE')
  ],

  GOWN: [
    c('OVERALL', { name: 'Overall Gown Design' }),
    c('FRONT'),
    c('BACK'),
    c('NECK'),
    c('SLEEVE'),
    c('WAIST'),
    { id: 'SKIRT_FLARE', name: 'Skirt / Flare Design',  aliases: ['skirt', 'flare', 'ghera', 'train'], queryTerms: ['skirt', 'flare'] },
    { id: 'BORDER_HEM',  name: 'Border / Hem Design',   aliases: ['border', 'hem', 'hemline'],         queryTerms: ['border', 'hem', 'closeup'] },
    c('SIDE'),
    c('EMBROIDERY', { name: 'Embroidery Design' }),
    c('PRINT')
  ],

  SUIT: [
    c('OVERALL', { name: 'Overall Suit Design' }),
    c('FRONT'),
    c('BACK'),
    c('NECK'),
    c('SLEEVE'),
    c('SIDE'),
    { id: 'BOTTOM_SALWAR', name: 'Bottom / Salwar Design', aliases: ['bottom', 'salwar', 'churidar', 'palazzo', 'pant'], queryTerms: ['salwar'] },
    c('BORDER'),
    c('EMBROIDERY', { name: 'Embroidery Design' }),
    c('PRINT')
  ],

  SHERWANI: [
    c('OVERALL', { name: 'Overall Sherwani Design' }),
    c('FRONT'),
    c('BACK'),
    { id: 'COLLAR_NECK', name: 'Collar / Neck Design', aliases: ['collar', 'neck', 'bandhgala', 'mandarin collar'], queryTerms: ['collar'] },
    c('SLEEVE'),
    { id: 'BUTTON',      name: 'Button Design',        aliases: ['button', 'buttons', 'buttoning'],                 queryTerms: ['button', 'closeup'] },
    c('POCKET'),
    { id: 'HEM_BOTTOM',  name: 'Hem / Bottom Design',  aliases: ['hem', 'bottom', 'hemline', 'daman'],              queryTerms: ['hem', 'closeup'] },
    c('SIDE'),
    c('EMBROIDERY', { name: 'Embroidery Design' }),
    { id: 'PRINT_PATTERN', name: 'Print / Pattern Design', aliases: ['print', 'pattern', 'printed', 'motif'],       queryTerms: ['print', 'pattern', 'closeup'] }
  ],

  BOTTOM_WEAR: [
    c('OVERALL', { name: 'Overall Bottom Wear Design' }),
    c('WAIST'),
    { id: 'UPPER_THIGH',   name: 'Upper / Thigh Design',   aliases: ['upper', 'thigh', 'hip'],                queryTerms: ['thigh'] },
    { id: 'LEG',           name: 'Leg Design',             aliases: ['leg', 'legs'],                          queryTerms: ['leg'] },
    { id: 'BOTTOM_ANKLE',  name: 'Bottom / Ankle Design',  aliases: ['ankle', 'bottom', 'cuff', 'mori'],      queryTerms: ['ankle', 'closeup'] },
    c('FLARE'),
    c('BORDER'),
    c('POCKET'),
    c('EMBROIDERY'),
    c('PRINT')
  ],

  LEHANGA: [
    c('OVERALL', { name: 'Overall Lehenga Design' }),
    { id: 'SKIRT',     name: 'Lehenga / Skirt Design', aliases: ['skirt', 'lehenga skirt', 'ghagra', 'kali'], queryTerms: ['skirt'] },
    c('BORDER'),
    { id: 'WAISTBAND', name: 'Waistband Design',       aliases: ['waistband', 'waist', 'belt', 'kamarband'],  queryTerms: ['waistband', 'closeup'] },
    c('EMBROIDERY'),
    c('PRINT')
  ],

  SHARARA: [
    c('OVERALL', { name: 'Overall Sharara Design' }),
    c('FRONT'),
    c('BACK'),
    c('NECK'),
    c('SLEEVE'),
    { id: 'FLARE_PANTS', name: 'Flare / Ghera Design',  aliases: ['flare', 'ghera', 'pants', 'sharara pants'], queryTerms: ['flared', 'pants'] },
    { id: 'HEM_BOTTOM',  name: 'Hem / Bottom Design',   aliases: ['hem', 'bottom', 'hemline', 'daman'],        queryTerms: ['hem', 'closeup'] },
    c('BORDER'),
    c('DUPATTA'),
    c('EMBROIDERY'),
    c('PRINT')
  ]
};

module.exports = { DESIGN_TYPES };
