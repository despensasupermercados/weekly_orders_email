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
// THE WEEKDAY IS THE HALF OF THE DATE A CREW HOLDS IN THEIR HEAD. "14 Sep" is
// something you look up; "MON 14" is a day you can count to. On a ship, where
// the date blurs and the day does not, it is the only half that means anything
// without a calendar.
assert.ok(/MON<\/div>/.test(fleet) && />14</.test(fleet),
  'the due date leads the row as a calendar block: weekday, number, month');
assert.ok(!/Order due <strong[^>]*><\/strong>/.test(fleet), 'no row may render an empty due date');

// NAME THE WINDOW, NOT THE SEND DATE. "Orders due - 11 Sep" is the day it was
// sent and says nothing about what it covers. The report looks seven days
// ahead, so it says which seven.
assert.ok(/Wed 9 Sep to Tue 15 Sep/.test(fleet),
  `the header must name the seven-day window: ${fleet.match(/[A-Z][a-z]{2} \d+ [A-Z][a-z]{2} to [^<&]*/)?.[0]}`);
// THE COUNT WAS WRONG ON THE FACE OF THE EMAIL: it counted ORDERED voyages and
// printed them as ships, so a 48-ship fleet was announced as "102 ships clear".
// A reader who spots an impossible number stops believing the whole page.
assert.ok(/\b1 of 2 ships ok\b/.test(fleet),
  `the clear count must be ships, not voyages: ${fleet.match(/[\w ]*ships ok/)?.[0]}`);

// A SHIP'S EMAIL CARRIES ONLY THAT SHIP. A crew member who has to hunt for
// their own line in a fleet-wide table stops opening the email.
const ship = renderWeekly(act, all, '2026-09-09', { audience: 'ship', ship: 'Celebrity Apex' });
assert.ok(ship.includes('Celebrity Apex'), "the ship's name must head its own email");
assert.ok(!ship.includes('ships ok'), 'a ship must not be shown fleet-wide counts');
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
assert.ok(overdue.includes('LATE'));
assert.ok(overdue.includes('The due date already passed'));

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

// ONE SHAPE, TWO SCOPES. The fleet digest and a ship's own email must teach the
// same page, or a printer who has learned one cannot read the other.
const shipCov = renderWeekly([], [...all, ...gridRows], '2026-09-11',
  { audience: 'ship', ship: 'Apex' });

// A page about one ship has no ship column and no SHIP header over one word -
// that header and its column ate 40% of the width in the first version.
assert.ok(!/>SHIP</.test(shipCov), "a ship's own strip needs no SHIP column header");
assert.ok(shipCov.includes('SEP') && shipCov.includes('FEB'),
  'and the months still span the whole six');

// A STRIP SHOWS A SHAPE; IT DOES NOT SAY WHAT THE SHAPE MEANS. A reader who is
// unsure does not act, so the ship's email says it in words underneath.
assert.ok(/Stock is coming until|Please act in /.test(shipCov),
  "a ship's strip must be followed by one plain sentence");

// The fleet digest keeps the column, because there the ship name IS the row.
assert.ok(/>SHIP</.test(withGrid) || /covered every month|ships have stock arriving/.test(withGrid),
  'the fleet view either names ships in rows or collapses them to one line');

console.log('ok - email: the coverage strip reads the same in both emails, and a ship sees');
console.log('     its own six months full width with the meaning stated in words');

// A SHIP WITH NO ORDERING SCHEDULE STILL GETS ITS SIX MONTHS. Miguel, 15 Sep
// 2026: Navigator's email ended with the stockouts and no strip. Drawn from the
// containers on their way instead, and labelled as such.
{
  const { renderWeekly } = await import('../src/lib/email.js');
  const nav = renderWeekly([], [], '2026-09-15', {
    audience: 'ship', ship: 'Navigator', gaps: [],
    runsOut: [{ ship: 'Navigator', item: 'TN619M MAGENTA TONER', on_hand: 2, rate: 5, stockout: '2026-09-27',
      next_loading: '2026-10-24', order_due: null, order_lands: null, add_qty: 8, add_basis: '5 used in 30 days + 3 spare', has_schedule: false }],
    deliveries: [{ ship: 'Navigator', date: '2026-10-24' }, { ship: 'Navigator', date: '2026-11-09' }, { ship: 'Explorer', date: '2026-10-01' }],
  });
  assert.ok(/Your next six months/.test(nav), 'a schedule-free ship gets its strip');
  assert.ok(/We have no order schedule for your ship/.test(nav), 'and is told which source drew it');
  assert.ok(/Stock is coming until <strong>Nov 2026/.test(nav), 'the strip reads to the last landing');
  assert.ok(!/Explorer/.test(nav), "another ship's deliveries never leak in");
  // A ship WITH a schedule is drawn from its voyage rows, never from transit.
  const sched = renderWeekly([], [{ ship: 'Quest', loading_delivery_date: '2026-10-14', due_date: '2026-07-03', state: 'ORDERED' }], '2026-09-15', {
    audience: 'ship', ship: 'Quest', gaps: [], runsOut: [], deliveries: [{ ship: 'Quest', date: '2027-02-01' }],
  });
  assert.ok(!/no ordering schedule/.test(sched));
  console.log('ok - email: a ship with no ordering schedule draws its six months from open orders');
}

// DEADLINE ORDER. Miguel, 15 Sep 2026: "always filter by the due date on
// these emails." Rows arrive grouped by ship; they must print by due date, the
// ones with no open order (a manual order to ask for today) first.
{
  const { renderWeekly } = await import('../src/lib/email.js');
  const row = (ship, item, order_due, stockout) => ({ ship, item, on_hand: 1, rate: 5, stockout,
    next_loading: null, order_due, order_lands: order_due ? '2026-12-31' : null, add_qty: 3, add_basis: 'x', has_schedule: Boolean(order_due) });
  const html = renderWeekly([], [], '2026-09-15', { gaps: [], deliveries: [], runsOut: [
    row('Allure', 'ITEM-LATE', '2026-11-01', '2026-10-01'),
    row('Brilliance', 'ITEM-SOON', '2026-09-20', '2026-10-05'),
    row('Constellation', 'ITEM-NONE', null, '2026-10-20'),
    row('Dawn', 'ITEM-MID', '2026-10-04', '2026-10-02'),
  ] });
  const at = (s) => html.indexOf(s);
  assert.ok(at('ITEM-NONE') < at('ITEM-SOON'), 'no open order sorts first');
  assert.ok(at('ITEM-SOON') < at('ITEM-MID'), 'then the earliest due date');
  assert.ok(at('ITEM-MID') < at('ITEM-LATE'), 'then the later one');
  console.log('ok - email: stockout rows print in due-date order, manual-order rows first');
}

// THE FIRST TILE IS ALWAYS A DUE DATE. Miguel, 16 Sep 2026: "never on these two
// tiles 'run out', but always due date." With no open order the deadline is
// today, and the day it runs out is text, not a tile.
{
  const { renderWeekly } = await import('../src/lib/email.js');
  const html = renderWeekly([], [], '2026-09-21', { gaps: [], deliveries: [], runsOut: [
    { ship: 'Navigator', item: 'TN619M MAGENTA TONER', on_hand: 2, rate: 5, stockout: '2026-09-27',
      next_loading: '2026-10-24', order_due: null, order_lands: null, add_qty: 8, add_basis: 'x', has_schedule: false },
  ] });
  assert.ok(!/RUNS OUT/.test(html), 'no tile is ever labelled RUNS OUT');
  const tile = /DUE DATE<\/div>\s*<div[^>]*>MON<\/div>\s*<div[^>]*>21<\/div>\s*<div[^>]*>SEP<\/div>/;
  assert.ok(tile.test(html), 'with no open order the DUE DATE tile is today');
  assert.ok(/Do this today: ask your Inventory Manager to check the next due date/.test(html), 'and the text says why');
  assert.ok(/empty by <strong>Sun 27 Sep/.test(html), 'the day it runs out is in the text');
  console.log('ok - email: the first tile is always DUE DATE; no open order means due today');
}

// SEND YOUR ORDERING SCHEDULE FIRST. Miguel, 16 Sep 2026: "the email should
// say: you are missing this file, do it first." A ship with no usable schedule
// is told at the top, with the reason its last attempt failed, and where to
// send the file. The fleet email lists the same ships in one table. A ship
// whose schedule is fine sees nothing about it.
{
  const { renderWeekly: rw } = await import('../src/lib/email.js');
  const schedules = [
    { ship: 'Ascent', status: 'image', detail: 'sent a png', last_attempt: '2026-09-12', last_due: null },
    { ship: 'Allure', status: 'stale', detail: 'ended', last_attempt: '2026-09-09', last_due: '2026-03-11' },
    { ship: 'Apex', status: 'ok', detail: 'fine', last_attempt: '2026-09-12', last_due: '2027-02-07' },
  ];
  const ascent = rw([], [], '2026-09-14', { audience: 'ship', ship: 'Ascent', schedules });
  assert.ok(/DO THIS FIRST/.test(ascent), 'the ask leads the ship email');
  assert.ok(/picture/.test(ascent), 'Ascent is told a screenshot is not the file');
  assert.ok(/obp@cims\.work/.test(ascent), 'and where to send it');
  assert.ok(/Ascent &mdash; 1 to do/.test(ascent), `the ask counts as a thing to do: ${ascent.match(/&mdash; \d+ to do/)?.[0]}`);
  assert.ok(/send your Ordering Schedule/.test(ascent), 'the preheader names it');
  const allure = rw([], [], '2026-09-14', { audience: 'ship', ship: 'Allure', schedules });
  assert.ok(/ended on <strong>Wed 11 Mar<\/strong>/.test(allure), 'a stale schedule names the day it ended');
  const apex = rw([], [], '2026-09-14', { audience: 'ship', ship: 'Apex', schedules });
  assert.ok(!/DO THIS FIRST/.test(apex), 'a ship with a schedule is not asked');
  const fleet2 = rw([], [], '2026-09-14', { schedules, checked: ['Ascent', 'Allure', 'Apex'] });
  assert.ok(/Ships with no Ordering Schedule/.test(fleet2), 'the fleet email carries the list');
  assert.ok(/sent a picture, not the file/.test(fleet2) && /schedule has ended/.test(fleet2), 'with the reason per ship');
  assert.ok(!/DO THIS FIRST/.test(fleet2), 'the fleet email does not shout the ship-level ask');
  assert.ok(/2 with no schedule/.test(fleet2) && /1 of 3 ships ok/.test(fleet2), `the strap counts them: ${fleet2.match(/[^>]*ships ok/)?.[0]}`);
  console.log('ok - email: a ship with no usable schedule is told what to send, why the last try failed, and where');
}

// ---------------------------------------------------------------------------
// RAY, REVIEWING THE 21 Sep 2026 TEST SEND: "We either tell the user they have
// enough until X date - this causes confusion."
//
// He flagged two emails and both carried the same pair of lines:
//   Star     "you will have none for 2 days"  +  "enough until Sun 1 Nov"
//   Infinity "none for 28 days"               +  "enough until Sat 2 Jan"
//
// Both halves were true and about DIFFERENT THINGS: `cover_to` is the end of
// the cycle AFTER the order lands, the dry gap is about now, before it lands.
// On a phone at the start of a shift that reads as a flat contradiction.
{
  const base = {
    ship: 'Star', item: '20 LBS 8.5 x 11 DG3 PAPER', description: '20 LBS 8.5 x 11 DG3 PAPER',
    on_hand: 23, rate: 63, stockout: '2026-10-02',
    order_due: '2026-09-27', order_lands: '2026-10-18', next_loading: '2026-10-04',
    add_qty: 0, add_basis: 'a pallet is already on that order', cover_to: '2026-11-01',
    severity: 'critical',
  };
  const opts = { gaps: [], deliveries: [], schedules: [], checked: ['Star'], audience: 'ship', ship: 'Star' };

  // A ship that WILL go dry is told about the gap and nothing else.
  const withGap = renderWeekly([], [], '2026-09-21', { ...opts, runsOut: [base] });
  assert.ok(/none for/.test(withGap), 'the gap is still reported');
  assert.ok(!/enough until/.test(withGap),
    'never promise "enough until" in the same box as "you will have none" — Ray, 21 Sep');

  // With no gap, the reassurance is exactly what the reader needs and stays.
  const noGap = renderWeekly([], [], '2026-09-21', {
    ...opts,
    runsOut: [{ ...base, next_loading: '2026-10-01', order_lands: '2026-10-01' }],
  });
  assert.ok(!/none for/.test(noGap), 'no gap to report when the order lands first');
  assert.ok(/enough until/.test(noGap), 'and then "enough until" is the useful line');
}

console.log('ok - ship email: "enough until" never appears beside "you will have none" (Ray, 21 Sep test send)');

// ---------------------------------------------------------------------------
// RAY, 23 Sep 2026, choosing between leaving the forecast alone, switching to
// the 3-month average, and showing both: "Show both."
//
// He had read Infinity's notice as too pessimistic - it said 11 a month where
// he remembered 6 - and the 11 was correct. It is his own SOP, the greater of
// last month or the trailing average, and August really was 11. The 6 was
// June. The email gave one number and no way to check it, so a correct
// forecast cost a round trip to defend.
{
  const mk = (o) => ({
    ship: 'Infinity', item: 'RADIANT WHITE 28# 11x17', description: 'RADIANT WHITE 28# 11x17',
    on_hand: 18, rate: 11, stockout: '2026-11-10', order_due: '2026-09-24',
    order_lands: '2026-12-20', next_loading: '2026-12-08', add_qty: 10,
    add_basis: '5 used in 13 days, minimum 10 cases', severity: 'critical', ...o,
  });
  const opts = { gaps: [], deliveries: [], schedules: [], checked: ['Infinity'], audience: 'ship', ship: 'Infinity' };
  const render = (f) => renderWeekly([], [], '2026-09-21', { ...opts, runsOut: [f] })
    .replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/\s+/g, ' ');

  // Infinity's real figures, measured against consumption_snapshot on 24 Sep.
  const real = render(mk({ rate_last: 11, rate_avg: 7.5, rate_avg_months: 2 }));
  assert.ok(/11 last month/.test(real), 'the month that drove the forecast is named');
  assert.ok(/8 average of 2 months/.test(real), 'and the average it beat, with its real sample size');
  assert.ok(/we plan on the higher one/.test(real), 'and which of the two the forecast used');

  // NEVER CLAIM A SAMPLE WE DO NOT HAVE. `avg3` is only three months when
  // three are measurable: a month needs the month before it inside the window
  // to have a previous on-hand to subtract. Infinity's is TWO.
  assert.ok(!/3 months/.test(real), 'must not say three months when only two were measured');
  assert.ok(/3 months/.test(render(mk({ rate_last: 11, rate_avg: 7, rate_avg_months: 3 }))), 'says three when it is three');
  assert.ok(!/average of 1 month/.test(render(mk({ rate_last: 11, rate_avg: 7, rate_avg_months: 1 }))), 'one month needs no "of N"');

  // The pair exists to show the GAP. When there is none it is noise on a line
  // the crew reads at the start of a shift.
  assert.ok(!/last month/.test(render(mk({ rate_last: 11, rate_avg: 11, rate_avg_months: 3 }))),
    'identical figures are not printed twice');
  assert.ok(!/last month/.test(render(mk({ rate_last: null, rate_avg: null, rate_avg_months: null }))),
    'no history, no claim');
}

console.log('ok - ship email: the rate shows both halves of Ray\'s rule when they differ, with the real number of months behind the average');
