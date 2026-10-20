// OBP'S OWN SHIP NUMBERS: tblShips.ShipID -> ShipName.
//
// The clicks file (Jerwin, first delivered 19 Oct 2026) names a ship only by
// OBP's internal ShipID, never by name. This map is OBP's own table, copied
// from the OBP Analytics Extract that IT generated on 9 Jul 2026 (SharePoint
// CruiseLineManagedServicesTeam / 5. IT / Data extract request / ships.csv).
// The names are spelled exactly as OBP's ShipName column, which the three
// nightly CSVs also carry, so a clicks row and an inventory row name a hull the
// same way. Checked against the clicks file itself: ShipID 14's press 336 is
// Navigator's AC58011021341 in the same extract's machines.csv.
//
// Rows OBP marks IsDeleted are left out (Wonder RCG, CIMS Warehouse, the two
// Florida warehouse rows, Regression Test 1). The extract covered Royal
// Caribbean and Celebrity only, so the Azamara hulls are NOT here: the clicks
// file carries ShipIDs 1, 2, 3 and 50, and which hull each is has not been
// given. A ShipID this map does not hold is stored with ship = NULL. It is
// never guessed.
export const OBP_SHIPS = Object.freeze({
  7: 'Wonder', 8: 'Allure', 9: 'Oasis', 10: 'Enchantment', 11: 'Rhapsody', 12: 'Radiance',
  13: 'Adventure', 14: 'Navigator', 15: 'Spectrum', 17: 'Voyager', 18: 'Anthem', 20: 'Vision',
  23: 'Quantum', 24: 'Freedom', 25: 'Explorer', 26: 'Independence', 32: 'Odyssey', 36: 'Liberty',
  37: 'Mariner', 38: 'Serenade', 40: 'Ovation', 42: 'Jewel', 43: 'Grandeur', 44: 'Brilliance',
  53: 'Harmony', 76: 'Icon', 79: 'Symphony', 80: 'Utopia', 83: 'Star', 85: 'Legend',
  64: 'Edge', 65: 'Apex', 66: 'Beyond', 67: 'Reflection', 68: 'Constellation', 69: 'Eclipse',
  70: 'Equinox', 71: 'Infinity', 72: 'Millennium', 73: 'Silhouette', 74: 'Solstice', 75: 'Summit',
  78: 'Ascent', 84: 'Xcel',
});

export const obpShipName = (id) => {
  const n = Number(id);
  return Number.isInteger(n) && Object.prototype.hasOwnProperty.call(OBP_SHIPS, n) ? OBP_SHIPS[n] : null;
};
