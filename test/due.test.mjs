// node test/due.test.mjs
// Guards the three rules that were got wrong in production:
//   1. eligibility is HOTEL BIWEEKLY HOTEL, not HOTEL MONTHLY
//   2. eligibility is not obligation - ships use every other biweekly loading
//   3. no PO = no order, and a source disagreement goes to Ray, not the ship
import { classifyAll, dataFaults, MAX_GAP_DAYS, MISSED_CREW_DAYS } from '../src/lib/due.js';
import assert from 'node:assert';

const T = '2026-09-09';
const dd = (due) => Math.round((Date.parse(due) - Date.parse(T)) / 86400000);
const mk = (ship, due, load, extra = {}) => ({
  ship, voyage: `${ship}${load}`, due_date: due, loading_delivery_date: load,
  days_to_due: dd(due), po_state: '', date_changed: 0, order_lines: 0,
  mot: 'HOTEL BIWEEKLY HOTEL', loading_port: 'X', ...extra,
});

// Summit orders 11 Sep and 9 Oct (28 days apart) and skips 25 Sep between them.
const summit = classifyAll([
  mk('Summit', '2026-08-10', '2026-09-11', { order_lines: 13 }),
  mk('Summit', '2026-08-24', '2026-09-25'),
  mk('Summit', '2026-08-25', '2026-10-09', { order_lines: 12 }),
], T);
const skipped = summit.find((r) => r.loading_delivery_date === '2026-09-25');
assert.equal(skipped.state, 'skippable',
  `the every-other-loading pattern must not be a miss, got ${skipped.state}`);
assert.equal(summit.filter((r) => r.state === 'ORDERED').length, 2);

// A real gap: nothing arriving for 65 days after the last covered loading.
const gap = classifyAll([
  mk('Ghost', '2026-08-01', '2026-09-01', { order_lines: 5 }),
  mk('Ghost', '2026-09-05', '2026-11-05'),
], T);
const risk = gap.find((r) => r.loading_delivery_date === '2026-11-05');
assert.ok(risk.gap_days > MAX_GAP_DAYS, 'fixture must exceed the gap threshold');
assert.equal(risk.state, 'MISSED', `a real gap past its due date is a miss, got ${risk.state}`);

// NO PO = NO ORDER holds for Azamara, and the source disagreement goes to Ray.
const az = classifyAll([
  mk('Journey', '2026-10-02', '2026-10-07', { mot: 'AZAMARA BWS', po_state: 'none', order_lines: 9 }),
  mk('Pursuit', '2026-09-25', '2027-01-20', { mot: 'AZAMARA BWS', po_state: 'raised' }),
], T);
assert.equal(az.find((r) => r.ship === 'Journey').state, 'PO_NOT_RECORDED',
  'blank PO + OBP order is a source disagreement for Ray - never ORDERED, never a chase');
assert.equal(az.find((r) => r.ship === 'Pursuit').state, 'ORDERED');

console.log('ok - cadence, gap detection, and no-PO-no-order all hold');

// ---------------------------------------------------------------------------
// HISTORY WITH A FIELD MISSING IS NOT A LIVE FAULT.
//
// Millennium's 17 Sep 2026 bulk load carried 24 HOTEL BIWEEKLY HOTEL rows dated
// May-Dec 2021 with no loading date. The `past` test keys on the loading date,
// so a row with none could never reach it: it hit NO_LOADING_DATE first, and
// the night check called "24 eligible voyages are UNUSABLE" a CRITICAL every
// night for a week. The Brain had noted on 18 Sep that they were 2021 history.
{
  const noLoad = (ship, due) => mk(ship, due, null, { voyage: null });
  const rows = classifyAll([
    noLoad('Millennium', '2021-05-03'),                    // 2021: history
    noLoad('Millennium', '2021-12-07'),                    // 2021: history
    noLoad('Anthem', '2026-09-30'),                        // due in 3 weeks, no loading date: a real fault
    noLoad('Vision', '2026-09-04'),                        // 5 days past due, no loading date: still live enough to be a fault
    mk('Ghost', '2026-08-01', '2026-11-05'),               // real MISSED: due passed, loading still ahead - must stay MISSED
  ], T);
  const st = (ship, due) => rows.find((r) => r.ship === ship && r.due_date === due).state;

  assert.equal(st('Millennium', '2021-05-03'), 'past', '2021 with no loading date is history, not a fault');
  assert.equal(st('Millennium', '2021-12-07'), 'past');
  assert.equal(st('Anthem', '2026-09-30'), 'NO_LOADING_DATE', 'a live voyage with no loading date is still a real fault');
  assert.equal(st('Vision', '2026-09-04'), 'NO_LOADING_DATE',
    `inside MISSED_CREW_DAYS (${MISSED_CREW_DAYS}) it could still be a live voyage with a bad field - keep it a fault`);
  assert.equal(st('Ghost', '2026-08-01'), 'MISSED', 'a genuine miss with a loading date is untouched');

  // And the night check only sees the live ones.
  const faults = dataFaults(rows).map((r) => r.ship);
  assert.deepEqual(faults.sort(), ['Anthem', 'Vision'], `dataFaults must exclude 2021 history, got ${faults}`);
}

console.log('ok - a voyage older than any crew can act on is history, not an ingest fault; live faults still report');

