// Which ships belong in the email at all, and in what order.
//
// NOT IN SERVICE. A hull under construction has no crew to read an email and
// no press to run dry. Legend of the Seas is still building and has no crew
// aboard until April 2027, yet it carries 1,527 inventory rows - which is why
// the runway check reported it out of 8.5x11 paper at 48 a month. That is an
// artefact of a seeded inventory, not a ship in trouble, and putting it at the
// top of a crew email would teach the reader that the top of the email is
// wrong. The Brain already flags Legend as a known contradiction.
//
// Dated, not deleted: on 1 April 2027 it simply starts appearing.
export const NOT_IN_SERVICE = {
  Legend: '2027-04-01',
};

export const inService = (ship, today) => {
  const from = NOT_IN_SERVICE[String(ship || '').trim()];
  return !from || String(today) >= from;
};

// AZAMARA GOES LAST. Miguel's ordering decision, 11 Sep 2026. The four Azamara
// hulls run on a different schedule entirely - no ordering schedule of their
// own, a BWS delivery date instead of a due date - so mixing them into the
// Royal and Celebrity rows makes a reader check which rules apply on every
// line. Grouped at the end, the reader checks once.
export const AZAMARA = new Set(['Journey', 'Onward', 'Pursuit', 'Quest']);
export const isAzamara = (ship) => AZAMARA.has(String(ship || '').trim());

// Sort comparator: Azamara after everything else, alphabetical within each
// group. Returns 0 on a tie, because a comparator that never returns 0 is
// inconsistent and this project has already shipped one of those.
export function byFleetOrder(a, b) {
  const sa = isAzamara(a) ? 1 : 0;
  const sb = isAzamara(b) ? 1 : 0;
  if (sa !== sb) return sa - sb;
  return a < b ? -1 : a > b ? 1 : 0;
}
