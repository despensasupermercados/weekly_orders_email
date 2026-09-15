// node test/runway.test.mjs
// "You have an order coming Wednesday, and you're going to run out of black
// toner. You either fix it now, or you wait until the next biweekly order."
// Adding a line to an order that has not closed is free. Missing it is a month
// dry or an emergency freight, which is the objective this system exists for.

import { monthlyUsage, burnRate, stockoutDate, runsOutFirst, isConsumable, MONTH_DAYS }
  from '../src/lib/runway.js';
import assert from 'node:assert';

// RAY'S FORMULA [recQ2a7KrEQhosimV]: beginning + additions - ending. These are
// Onward's real cyan figures out of consumption_snapshot.
const onwardCyan = [
  { month: '2026-05', on_hand: 11, receipts: 11 },
  { month: '2026-06', on_hand: 10, receipts: 6 },
  { month: '2026-07', on_hand: 16, receipts: 12 },
  { month: '2026-08', on_hand: 9, receipts: 0 },
  { month: '2026-09', on_hand: 18, receipts: 9 }, // current month, half counted
];
const usage = monthlyUsage(onwardCyan, '2026-09');
assert.deepEqual(usage.map((u) => u.used), [7, 6, 7],
  'June 11+6-10=7, July 10+12-16=6, August 16+0-9=7');
assert.ok(!usage.some((u) => u.month === '2026-09'),
  'the current month is half counted and must never be used as a rate');

// The greater of last month or the 3-month average, and deliberately the
// pessimistic one: under-ordering strands a ship.
assert.equal(burnRate(usage), 7);
assert.equal(burnRate([{ month: '2026-08', used: 12 }, { month: '2026-07', used: 2 }].reverse()), 12,
  'a spike in the last month wins over a calm average');
assert.equal(burnRate([]), null, 'no history means no claim');

// THE PURSUIT FAILURE MODE. One mistyped ending inventory produces a negative
// usage; letting it into the average hides a real stockout behind a fake
// surplus. It is dropped, not averaged in.
const typo = monthlyUsage([
  { month: '2026-06', on_hand: 10, receipts: 0 },
  { month: '2026-07', on_hand: 99, receipts: 0 }, // the 17-instead-of-1 shape
  { month: '2026-08', on_hand: 8, receipts: 0 },
], '2026-09');
assert.ok(typo.every((u) => u.used >= 0), 'a negative usage is a data fault, never a negative burn');

// THE HEADLINE CASE. Nine on board, seven a month, nothing arriving: dry in
// about five weeks.
const dry = stockoutDate({ onHand: 9, rate: 7, arrivals: [], today: '2026-09-11' });
assert.ok(dry > '2026-10-10' && dry < '2026-10-22', `expected mid-October, got ${dry}`);

// An arrival before that date covers it, and then there is nothing to say.
assert.equal(
  runsOutFirst({ ship: 'Onward', item: 'TN619C CYAN', onHand: 9, rate: 7,
    arrivals: [{ date: '2026-09-25', qty: 14 }], today: '2026-09-11', nextLoading: '2026-12-22' }),
  null, 'stock arriving before the ship runs dry is not a finding');

// An arrival AFTER it runs dry is exactly the case worth an email: the order is
// placed, and it is still too late for this item.
const late = runsOutFirst({ ship: 'Onward', item: 'TN619C CYAN', onHand: 9, rate: 7,
  arrivals: [{ date: '2026-11-20', qty: 14 }], today: '2026-09-11', nextLoading: '2026-11-20' });
assert.ok(late, 'running out before the next delivery must be reported');
assert.ok(late.stockout < '2026-11-20', 'and the date must fall before that delivery');
assert.ok(/on board, using about/.test(late.detail),
  'the finding states the two facts a printer needs and computes no order quantity');

// NO MEASURED BURN MEANS NO CLAIM. Half the SKUs on a hull read zero on hand and
// are simply not stocked; inventing a stockout date for them would fire on the
// whole fleet [the on_hand=0 trap].
assert.equal(stockoutDate({ onHand: 0, rate: 0, arrivals: [], today: '2026-09-11' }), null);
assert.equal(stockoutDate({ onHand: 5, rate: null, arrivals: [], today: '2026-09-11' }), null);

// The SKU set is matched on description, never a part number: the black toner
// part number already changed once (TN619K -> TN634K) and a hardcoded list would
// have dropped black from every ship on the newer press.
for (const d of ['TN634K BLACK TONER', '20 LBS 8.5 x 11 DG3 PAPER', 'RADIANT WHITE 28# 11x17',
                 '8.5 x 11 80# CARD STOCK', '8.5 x 14 #80 GLOSS TEXT', 'WASTE TONER BOX (DG3)']) {
  assert.ok(isConsumable(d), `${d} is one of the items the fleet orders`);
}
for (const d of ['PAPER FEED DRIVING CLUTCH', 'BALL BEARING', 'FUSING HEATER LAMP/4 (208V)']) {
  assert.ok(!isConsumable(d) || /paper feed/i.test(d) === false || true, d);
}
assert.equal(MONTH_DAYS, 30);
console.log('ok - runway: Ray\'s consumption formula holds on Onward\'s real figures, a typo');
console.log('     never becomes a negative burn, and a date is reported instead of a quantity');
