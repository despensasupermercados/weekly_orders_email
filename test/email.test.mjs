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

// THE SIX-MONTH GRID. The Brain's locked decision is "action list first,
// six-month grid as reference", and the grid was missing entirely - the email
// showed only the next seven days. These pin it so it cannot quietly vanish
// again, because a missing reference section looks exactly like a quiet week.
const gridRows = [
  { ...row('Apex', '2026-09-14', '2026-09-28'), state: 'ORDERED' },
  { ...row('Apex', '2026-10-20', '2026-11-04'), state: 'skippable' },
  { ...row('Quest', '2026-12-01', '2026-12-18'), state: 'upcoming' },
];
const withGrid = renderWeekly(act, [...all, ...gridRows], '2026-09-11');
assert.ok(/next six months/i.test(withGrid), 'the fleet email must carry the six-month grid');
for (const m of ['Sep 26', 'Oct 26', 'Nov 26', 'Dec 26', 'Jan 27', 'Feb 27']) {
  assert.ok(withGrid.includes(m), `the grid must span six months, missing ${m}`);
}
assert.ok(withGrid.includes('skip'), 'the grid must show the biweekly skip, which is the cadence nobody believes');

// A ship's grid carries that ship only, same rule as the action list.
const shipGrid = renderWeekly(act, [...all, ...gridRows], '2026-09-11',
  { audience: 'ship', ship: 'Apex' });
assert.ok(/Your next six months/i.test(shipGrid), "a ship must get its own grid");
assert.ok(!shipGrid.includes('Quest'), "one ship's grid must never name another ship");

// THE LETTERHEAD IS THE CANONICAL FILE, NEVER HAND-WRITTEN (convention section 1).
// It was inlined here, which is how fifteen competing letterheads happened.
import { mastRows } from '../src/cims-mast.js';
assert.ok(withGrid.includes(mastRows().trim().slice(0, 120)),
  'the letterhead must come from src/cims-mast.js, not a local copy of the markup');

// Outlook renders through Word: it drops rgba() and ignores linear-gradient().
// Both have already shipped as live bugs in this estate.
assert.ok(!/rgba\(|linear-gradient\(/.test(withGrid), 'no rgba and no gradient, ever');

// Brand tokens, section 3. Three of these had drifted: cloud was #F4F5F7, red
// #8F231A, amber #8A5B00. Red only renders when something is actually overdue,
// so it is asserted against the overdue render rather than the calm one.
for (const hex of ['#F3F4F6', '#B7791F']) {
  assert.ok(withGrid.includes(hex), `canonical token ${hex} must be the one in use`);
}
assert.ok(overdue.includes('#96281B'), 'canonical red #96281B must be the one in use');
for (const stale of ['#F4F5F7', '#8F231A', '#8A5B00']) {
  assert.ok(!withGrid.includes(stale) && !overdue.includes(stale),
    `drifted token ${stale} must not reappear`);
}
console.log('ok - email: the six-month grid is present and ship-scoped, the letterhead is the');
console.log('     canonical file, and the brand tokens match the convention');
