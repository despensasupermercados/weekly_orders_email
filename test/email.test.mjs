// node test/email.test.mjs
// The crew email's job is to remove "I didn't know" and "I didn't know when".
// Both assertions below are about that sentence, not about styling.

import { renderWeekly } from '../src/lib/email.js';
import assert from 'node:assert';

const row = (ship, due, load, state = 'DUE NOW', days = 5) => ({
  ship, due_date: due, loading_delivery_date: load, loading_port: 'Barcelona',
  voyage: 'OD1234', state, days_to_due: days, date_changed: 0,
});

const all = [row('Apex', '2026-09-14', '2026-09-28'), { ...row('Quest', '2026-09-16', '2026-10-01'), state: 'ORDERED' }];
const act = [row('Apex', '2026-09-14', '2026-09-28')];

// EVERY LISTED ROW MUST CARRY A REAL DATE. A warning with an empty deadline in
// it hands back the exact excuse this email exists to remove, and that is what
// a NULL due date used to render as.
const fleet = renderWeekly(act, all, '2026-09-09');
assert.ok(fleet.includes('14 Sep'), 'the due date must appear in the row');
assert.ok(!/Order due <strong[^>]*><\/strong>/.test(fleet), 'no row may render an empty due date');
assert.ok(fleet.includes('1 ships clear') || fleet.includes('ships clear'),
  'the fleet digest carries the clear count');

// A SHIP'S EMAIL CARRIES ONLY THAT SHIP. A crew member who has to hunt for
// their own line in a fleet-wide table stops opening the email.
const ship = renderWeekly(act, all, '2026-09-09', { audience: 'ship', ship: 'Celebrity Apex' });
assert.ok(ship.includes('Celebrity Apex'), "the ship's name must head its own email");
assert.ok(!ship.includes('ships clear'), 'a ship must not be shown fleet-wide counts');
assert.ok(!ship.includes('Quest'), "one ship's email must never name another ship");

// Ray signs it, and the escalation path stays in both versions.
for (const html of [fleet, ship]) {
  assert.ok(html.includes('Ray Guerra'), 'the fleet email is signed by Ray');
  assert.ok(html.includes('An order without a PO is not an order.'),
    'the no-PO-no-order rule must be stated to the crew, not just enforced in code');
}

// Overdue must read as overdue, not as a countdown.
const overdue = renderWeekly(
  [{ ...row('Apex', '2026-09-01', '2026-09-28'), state: 'MISSED', days_to_due: -8 }], all, '2026-09-09');
assert.ok(overdue.includes('OVERDUE'));
assert.ok(overdue.includes('the due date has passed'));

console.log('ok - email: every listed row carries a real deadline, a ship sees only itself,');
console.log('     and the no-PO-no-order rule is stated to the crew');
