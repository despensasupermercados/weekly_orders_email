// Which ships belong in the email at all, and in what order.
//
// NOT IN SERVICE. A hull under construction has no crew to read an email and
// no press to run dry, so a hull can be listed here with the date its crew
// boards; on that date it simply starts appearing.
//
// LEGEND WAS LISTED HERE BY MISTAKE (11 Sep to 18 Sep 2026). The entry said
// "still building, no crew until April 2027" and cited the Brain's known
// contradiction on Legend. The Brain had already RESOLVED that contradiction
// on 8 Sep 2026 (entity recJlr3en9dBbVAa4, corrections field: "Legend of the
// Seas is a live vessel with loadings and consumption; the newbuild-2027 note
// was the stale side"), and the entry was written without reading it. The
// evidence was all in D1 the whole time: Legend's printer mailbox sent its
// Ordering Schedule on 12 Sep (21 DG3 orders); consumption_snapshot shows
// receipts of 193 in May and 270 in August 2026 with stock drawn down between;
// 29 in-transit lines land between 24 Sep 2026 and 3 Jan 2027; cims-timecard
// carries an active crew roster. Royal's own site lists Legend as debuted July
// 2026; the 2027 newbuild is Hero. Every Monday from 15 Sep to 18 Sep 2026
// judged the fleet with Legend silently dropped. Read the entity's
// corrections field BEFORE writing a rule about a ship - the Brain's process
// lesson of 10 and 16 Sep, missed a third time here.
export const NOT_IN_SERVICE = {};

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
