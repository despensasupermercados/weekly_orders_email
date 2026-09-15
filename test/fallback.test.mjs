// node test/fallback.test.mjs
// The objective record is explicit: "it must never fall silent just because one
// input is missing - silence is exactly how an order gets forgotten and an
// emergency shipment gets paid." The weekly email covered 23 of 48 ships. These
// pin the path that covers the other 25.

import { gapFindings, median, MIN_GAP_DAYS, GAP_MULTIPLE } from '../src/lib/fallback.js';
import assert from 'node:assert';

const d = (ship, ...dates) => dates.map((date) => ({ ship, date }));
const TODAY = '2026-09-11';

assert.equal(median([28, 28, 30]), 28);
assert.equal(median([26, 30]), 28);
assert.equal(median([]), null);

// A SHIP KEEPING ITS OWN RHYTHM IS SILENT. Roughly 28 days apart is exactly the
// biweekly-every-other-loading cadence the Brain recorded, and flagging it would
// fire on the whole fleet every week.
assert.equal(
  gapFindings(d('Anthem', '2026-09-20', '2026-10-18', '2026-11-15', '2026-12-13'), TODAY).length,
  0, "a ship on its usual 28-day rhythm must produce nothing");

// THE REAL CASE, FROM LIVE DATA. Anthem has 51 days between 30 Sep and 20 Nov
// while its own interval is about 28. Nobody was told, because Anthem has no
// ordering schedule and the weekly email could not see it at all.
const anthem = gapFindings(
  d('Anthem', '2026-09-02', '2026-09-30', '2026-11-20', '2026-12-18'), TODAY);
assert.equal(anthem.length, 1, 'a gap at nearly twice the ship\'s own interval must be found');
assert.equal(anthem[0].gap_days, 51);
assert.equal(anthem[0].after_delivery, '2026-09-30');
assert.equal(anthem[0].next_delivery, '2026-11-20');
assert.ok(/no ordering schedule/.test(anthem[0].basis),
  'the finding must say the evidence is weaker, every time');

// JUDGED AGAINST THE SHIP, NOT THE FLEET. A vessel that genuinely loads every
// 45 days is not missing anything at 50, and one that loads every 20 is.
assert.equal(
  gapFindings(d('Slow', '2026-09-15', '2026-10-30', '2026-12-14', '2027-01-28'), TODAY).length,
  0, 'a ship with a long natural interval must not be flagged for keeping it');

// ...but the floor still holds: never warn on a short gap however tight the
// ship's rhythm, or a vessel loading weekly generates a finding every week.
const tight = gapFindings(d('Tight', '2026-09-12', '2026-09-19', '2026-10-10', '2026-10-17'), TODAY);
assert.ok(tight.every((f) => f.gap_days > MIN_GAP_DAYS),
  `nothing at or under ${MIN_GAP_DAYS} days may be reported, whatever the multiple`);

// A PAST GAP IS NOT ACTIONABLE. The due date for it is long gone, and repeating
// an instruction nobody can act on is how this email gets filtered.
assert.equal(
  gapFindings(d('Past', '2026-05-01', '2026-07-20', '2026-08-01'), TODAY).length,
  0, 'a gap that has already passed must not be reported to a crew');

// Two points is not a rhythm. Calling a gap on one interval is a confident
// wrong answer, which this project has already paid for three times.
assert.equal(gapFindings(d('Thin', '2026-09-20', '2026-12-20'), TODAY).length, 0,
  'fewer than three deliveries means no baseline, so no finding');

assert.equal(GAP_MULTIPLE, 1.5);
console.log('ok - fallback: the 25 ships with no ordering schedule are no longer silent,');
console.log('     each judged against its own interval, and never on a gap already past');
