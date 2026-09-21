// DID THIS RUN ACTUALLY LOOK AT THE WHOLE FLEET?
//
// Miguel, 21 Sep 2026: "how certain are we we will NOT skip one coz we don't
// have the data". The honest answer that morning was: we would not find out.
// Three ways a ship fell out of a weekly run without anyone being told.
//
//  1. UNREADABLE QUANTITIES WERE COLLECTED AND THROWN AWAY. runwayDb builds an
//     `unread` list for every item whose on_hand could not be read and returns
//     it; index.js took `findings` and `shipNames` and never read it. An item
//     we could not measure produced no finding, so the ship read CLEAR on it.
//     Zero fleet-wide on 21 Sep, so it was latent - and latent is exactly how
//     it stays until the first blank column, which is the failure the OBP CSV
//     refusal rules already exist to catch one layer up.
//
//  2. A BROKEN CHECK LOOKED IDENTICAL TO A HEALTHY FLEET. When the runway, gap
//     or schedule check did not run, index.js logged one line to ingest_log and
//     carried on with an EMPTY findings array. Zero findings from a dead check
//     and zero findings from 48 healthy ships produce the same email - and if
//     every check died, the quiet-return fired and there was no email at all.
//
//  3. THE DENOMINATOR MOVED. The fleet header read "N of M ships ok" where M
//     was the ships this run happened to examine, not the ships we address. A
//     ship that vanished from the data did not become a problem; it shrank M.
//     "35 of 45 ships ok" reads perfectly well while three ships are missing.
//
// So the run now states what it could NOT do, and the denominator is the fleet
// we address - a number that only changes when a human edits FLEET_MAP.
//
// WHO HEARS ABOUT IT. Nothing in here ever reaches a crew. due.js:226 settled
// that rule for unusable voyage rows and it holds for all of this: a Printer
// Specialist cannot fix an OBP export, a dead D1 query or a missing snapshot,
// and a warning you cannot act on teaches people to ignore the ones you can.
// The ship's OWN failure - no Ordering Schedule, an unreadable one - is a
// different thing entirely, it reaches the ship, and scheduleStatus.js owns it.

import { parseFleetMap, normShip } from './fleet.js';
import { inService } from './fleetStatus.js';

// checks: [{ name, ran, reason }] - one per data source the run depends on.
// checked: ship names any check actually examined.
// unread: [{ ship, item }] from fleetRunway - quantities we could not read.
export function fleetCoverage({ fleetMap, checked = [], checks = [], unread = [], today }) {
  const { map } = parseFleetMap(fleetMap);

  // The fleet we address, minus hulls with nobody aboard to act. A ship out of
  // service is not "unexamined" - there is nothing to examine.
  const addressed = [];
  for (const [key, hit] of map) {
    const name = (hit && hit.ship) || key;
    if (inService(name, today)) addressed.push({ key, name });
  }

  const seen = new Set((checked || []).map(normShip));
  const unexamined = addressed.filter((s) => !seen.has(s.key)).map((s) => s.name).sort();
  const broken = (checks || []).filter((c) => c && c.ran === false)
    .map((c) => ({ name: c.name, reason: c.reason || 'no reason given' }));

  // Group the unread items by ship: "Vision (3 items)" is a line an ops reader
  // can act on; forty item numbers is a wall they will skim past.
  const byShip = new Map();
  for (const u of unread || []) {
    if (!u || !u.ship) continue;
    const k = normShip(u.ship);
    if (!byShip.has(k)) byShip.set(k, { ship: u.ship, items: [] });
    byShip.get(k).items.push(u.item);
  }
  const unreadByShip = [...byShip.values()].sort((a, b) => a.ship.localeCompare(b.ship));
  const unreadItems = (unread || []).length;

  const ok = !unexamined.length && !broken.length && !unreadItems;

  // One line per problem, in the words an ops reader needs. Never rendered to
  // a crew; see the header comment.
  const lines = [];
  for (const b of broken) {
    lines.push(`The ${b.name} check did not run — ${b.reason}. Every ship reads clear on it, which may not be true.`);
  }
  if (unexamined.length) {
    lines.push(`${unexamined.length} addressed ${unexamined.length === 1 ? 'ship was' : 'ships were'} not examined by any check: ${unexamined.join(', ')}.`);
  }
  if (unreadItems) {
    lines.push(`${unreadItems} on-hand ${unreadItems === 1 ? 'quantity' : 'quantities'} could not be read on ${unreadByShip.length} ${unreadByShip.length === 1 ? 'ship' : 'ships'}: ${unreadByShip.map((u) => `${u.ship} (${u.items.length})`).join(', ')}. Those items were NOT measured for running out.`);
  }

  return {
    addressed: addressed.length,
    examined: addressed.length - unexamined.length,
    unexamined,
    broken,
    unreadByShip,
    unreadItems,
    ok,
    lines,
    // For the ingest_log line, which has to stay one short readable string.
    note: ok ? null : [
      broken.length ? `${broken.length} check(s) did not run (${broken.map((b) => b.name).join(', ')})` : null,
      unexamined.length ? `${unexamined.length} ship(s) unexamined (${unexamined.join(', ')})` : null,
      unreadItems ? `${unreadItems} on-hand value(s) unreadable` : null,
    ].filter(Boolean).join('; '),
  };
}
