// node test/due.test.mjs
// Guards the three rules that were got wrong in production:
//   1. eligibility is HOTEL BIWEEKLY HOTEL, not HOTEL MONTHLY
//   2. eligibility is not obligation - ships use every other biweekly loading
//   3. no PO = no order, and a source disagreement goes to Ray, not the ship
import { classifyAll, MAX_GAP_DAYS } from '../src/lib/due.js';
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
