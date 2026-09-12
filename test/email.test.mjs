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
// THE COUNT WAS WRONG ON THE FACE OF THE EMAIL: it counted ORDERED voyages and
// printed them as ships, so a 48-ship fleet was announced as "102 ships clear".
// A reader who spots an impossible number stops believing the whole page.
assert.ok(/\b1 of 2 ships clear\b/.test(fleet),
  `the clear count must be ships, not voyages: ${fleet.match(/[\w ]*ships clear/)?.[0]}`);

// A SHIP'S EMAIL CARRIES ONLY THAT SHIP. A crew member who has to hunt for
// their own line in a fleet-wide table stops opening the email.
const ship = renderWeekly(act, all, '2026-09-09', { audience: 'ship', ship: 'Celebrity Apex' });
assert.ok(ship.includes('Celebrity Apex'), "the ship's name must head its own email");
assert.ok(!ship.includes('ships clear'), 'a ship must not be shown fleet-wide counts');
assert.ok(!ship.includes('Quest'), "one ship's email must never name another ship");

// Ray signs it, and the escalation path stays in both versions.
for (const html of [fleet, ship]) {
  assert.ok(html.includes('Ray Guerra'), 'the fleet email is signed by Ray');
  assert.ok(/No PO means no order/.test(html),
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
assert.ok(/next six months/i.test(withGrid), 'the fleet email must carry the six-month view');
for (const m of ['SEP', 'OCT', 'NOV', 'DEC', 'JAN', 'FEB']) {
  assert.ok(withGrid.includes(m), `the months must span six columns, missing ${m}`);
}
// The year is marked once, where it turns over - not repeated on all six.
assert.ok(withGrid.includes("'27"), 'the year must be marked where it changes');
assert.equal(withGrid.split("'27").length - 1, 2, "and only on the months that are in it");

// "SKIP" IS NOT DATA. It filled half the old grid telling the reader, forty-odd
// times, that a loading does not concern them.
assert.ok(!/>\s*\d+ skip/.test(withGrid), 'a skipped loading must not occupy a cell');

// "12 ordered" WAS A DATE THAT READ AS A QUANTITY - the 12th, ordered, scanned
// as twelve units. Nothing in a covered cell now.
assert.ok(!/\d+ ordered/.test(withGrid), 'no cell may print a day number next to a state word');

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

// ONE CODE, NOT THREE [recQ2a7KrEQhosimV point 3]: "the same red / yellow /
// green language as OBP and as the weekly email. Keep the language consistent
// across all three so the crew learn one code, not three."
import { LEGEND } from '../src/lib/email.js';
const RED_HEX = '#96281B';
assert.equal(LEGEND.length, 3, 'three states, the same three the crew already read');

// GREEN MUST EXIST. This email had red and amber only, so every row a printer
// saw was an alarm colour and there was no "you are covered" state at all -
// which is the state most of the fleet is in.
assert.ok(withGrid.includes('#3E7F2E'), 'the green state must appear');

// RED IS RESERVED FOR PAST THE CUT-OFF. It used to fire on anything inside
// three days, which spends the colour that has to mean "too late" on something
// the crew can still fix - and then nothing is left to say "too late" with.
const soon = renderWeekly(
  [{ ...row('Apex', '2026-09-13', '2026-09-28'), state: 'DUE NOW', days_to_due: 2 }],
  all, '2026-09-11');
// The legend always renders red once, so count rather than test presence: a
// calm week shows red in the key and nowhere else.
const redCount = (html) => html.split(RED_HEX).length - 1;
assert.equal(redCount(soon), 1, 'a deadline two days out is amber; red appears only in the legend');
assert.ok(soon.includes('#B7791F'), 'it is the amber act-now state');
assert.ok(redCount(overdue) > 1, 'past the cut-off is red in the row, not just the legend');

// The legend is stated in the email, so the colour is readable by someone who
// has never opened one of these before.
for (const word of ['LATE', 'ORDER NOW', 'OK']) {
  assert.ok(withGrid.includes(word), `the legend must name the state "${word}"`);
}
// AND STAY SHORT. Each state used to carry a full clause that wrapped to two
// lines and pushed the first real row off the first screen. The crew read
// English as a second language; the colour is the code, the words are a nudge.
for (const [, , label, what] of LEGEND) {
  assert.ok(label.length <= 9, `legend label "${label}" is too long to scan`);
  assert.ok(what.split(' ').length <= 4, `legend note "${what}" is a lesson, not a reminder`);
}

// THE POLICY BELONGS IN THE SMALL PRINT. Two dense paragraphs used to sit
// between the heading and the first actionable row.
const beforeFirstRow = withGrid.slice(0, withGrid.indexOf('Order due'));
assert.ok(!/inventory manager will accept/.test(beforeFirstRow),
  'the cut-off policy must not sit above the first row a reader needs');
assert.ok(withGrid.includes('No PO means no order'),
  'but it must still be stated, in the footer, in short sentences');
console.log('ok - email: red/yellow/green matches the code the crew already read on OBP,');
console.log('     red is reserved for past the cut-off, and the legend is stated');
