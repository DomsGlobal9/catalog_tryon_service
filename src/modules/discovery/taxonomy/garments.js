// =============================================================================
// garments.js — The garment vocabulary Design Discovery understands.
// =============================================================================
//
// SOURCE OF TRUTH. Nothing outside this folder hardcodes a garment name, and the
// search provider knows none of them — it only ever receives a finished query
// string.
//
// CANONICAL IDS follow the generation service's existing spelling (LEHANGA,
// KURTHI), so one platform-wide id refers to one garment. The alternate and more
// conventional spellings (LEHENGA, KURTI) are accepted as aliases and
// canonicalised on the way in, and `name` carries the spelling a UI should show.
// This deliberately avoids editing the generation service.
//
// - `id`         canonical, what the API accepts and echoes back
// - `name`       display label for the Manage Designs UI
// - `aliases`    lowercase forms accepted on input and matched by the
//                instruction parser. Include the id's own lowercase form.
// - `searchNoun` what actually goes into the provider query. Not always the
//                display name: we search "lehenga", never "lehanga".

const GARMENTS = [
  {
    id: 'SAREE',
    name: 'Saree',
    aliases: ['saree', 'sarees', 'sari', 'saris', 'seere'],
    searchNoun: 'saree'
  },
  {
    id: 'BLOUSE',
    name: 'Blouse',
    aliases: ['blouse', 'blouses', 'choli', 'ravike'],
    searchNoun: 'blouse'
  },
  {
    id: 'DUPATTA',
    name: 'Dupatta',
    aliases: ['dupatta', 'dupattas', 'chunni', 'odhni', 'chunari', 'stole'],
    searchNoun: 'dupatta'
  },
  {
    // Canonical spelling inherited from the generation service (KURTHI).
    id: 'KURTHI',
    name: 'Kurti',
    aliases: ['kurthi', 'kurti', 'kurtis', 'kurtha', 'kurta', 'kurtas'],
    searchNoun: 'kurti'
  },
  {
    id: 'ANARKALI',
    name: 'Anarkali',
    aliases: ['anarkali', 'anarkalis'],
    searchNoun: 'anarkali'
  },
  {
    id: 'PETTICOAT',
    name: 'Petticoat',
    aliases: ['petticoat', 'petticoats', 'inskirt', 'underskirt'],
    searchNoun: 'petticoat'
  },
  {
    id: 'GOWN',
    name: 'Gown',
    aliases: ['gown', 'gowns', 'evening gown'],
    searchNoun: 'gown'
  },
  {
    id: 'SUIT',
    name: 'Suit (Kameez)',
    aliases: ['suit', 'suits', 'kameez', 'salwar kameez', 'salwar suit', 'churidar suit'],
    searchNoun: 'salwar kameez'
  },
  {
    id: 'SHERWANI',
    name: 'Sherwani',
    aliases: ['sherwani', 'sherwanis', 'shervani'],
    searchNoun: 'sherwani'
  },
  {
    id: 'BOTTOM_WEAR',
    name: 'Bottom Wear',
    aliases: ['bottom wear', 'bottomwear', 'bottom', 'palazzo', 'palazzos', 'salwar',
              'churidar', 'patiala', 'dhoti pants', 'trousers'],
    searchNoun: 'bottom wear'
  },
  {
    // Canonical spelling inherited from the generation service (LEHANGA),
    // but we search for the conventional spelling.
    id: 'LEHANGA',
    name: 'Lehenga',
    aliases: ['lehanga', 'lehenga', 'lehengas', 'lehngha', 'lehnga', 'ghagra', 'chaniya choli'],
    searchNoun: 'lehenga'
  },
  {
    // Present in the generation service, so discovery supports it too - otherwise
    // a boutique could generate a sharara catalogue but not discover references
    // for one.
    id: 'SHARARA',
    name: 'Sharara',
    aliases: ['sharara', 'shararas', 'gharara', 'garara'],
    searchNoun: 'sharara'
  }
];

module.exports = { GARMENTS };
