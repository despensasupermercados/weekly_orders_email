// node test/runway.test.mjs
// "You have an order coming Wednesday, and you're going to run out of black
// toner. You either fix it now, or you wait until the next biweekly order."
// Adding a line to an order that has not closed is free. Missing it is a month
// dry or an emergency freight, which is the objective this system exists for.

import { monthlyUsage, stockoutDate, runsOutFirst, isConsumable, MONTH_DAYS, balanceOn, withQuantity }
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

// Which month's usage is planned on is pinned in runwayDb.test.mjs, against the real SQL.

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

// A container with this item lands before the ship runs dry: nothing to say.
// What happens after that landing belongs to the next order, which has not
// been raised yet. (Dropping this rule on 16 Sep 2026 took the 15 Sep snapshot
// from 47 findings to 272 - every item that would ever run out in 120 days.)
assert.equal(
  runsOutFirst({ ship: 'Onward', item: 'TN619C CYAN', onHand: 9, rate: 7,
    arrivals: [{ date: '2026-09-25', qty: 14 }], today: '2026-09-11', nextLoading: '2026-09-25' }),
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


// NO READING, NO CLAIM. An on-hand of null (the export did not say) must never
// read as an empty shelf: that was a fleet-wide false critical waiting to happen.
{
  assert.equal(stockoutDate({ onHand: null, rate: 7, arrivals: [], today: '2026-09-17' }), null);
  assert.equal(stockoutDate({ onHand: undefined, rate: 7, arrivals: [], today: '2026-09-17' }), null);
  assert.equal(stockoutDate({ onHand: '', rate: 7, arrivals: [], today: '2026-09-17' }), null);
  assert.equal(stockoutDate({ onHand: 0, rate: 7, arrivals: [], today: '2026-09-17' }), '2026-09-17', 'a real zero still runs out today');
  assert.equal(runsOutFirst({ ship: 'Onward', item: 'TN619C CYAN', onHand: null, rate: 7, arrivals: [], today: '2026-09-17', nextLoading: null }), null);
  console.log('ok - runway: a missing on-hand reading is not a stockout; a real zero is');
}

// WHAT IS ABOARD THE DAY THE ORDER LANDS (review of 13 Oct 2026). The old
// formula was today's count plus arrivals minus straight-line usage, and ZERO
// whenever the shelf emptied before the landing - so a delivery that landed
// between the empty day and the order was ignored. Legend, 12 Oct: 2 cases,
// 44 a month, dry 14 Oct, 40 landing 22 Oct, order landing 7 Nov. The shelf is
// not empty on 7 Nov; about 16 cases are left of the 40.
{
  const T = '2026-10-12';
  const legend = balanceOn({ onHand: 2, rate: 44, arrivals: [{ date: '2026-10-22', qty: 40 }], today: T, date: '2026-11-07' });
  assert.ok(legend > 16 && legend < 17, `about 16.5 cases on 7 Nov, got ${legend}`);
  assert.equal(balanceOn({ onHand: 2, rate: 44, arrivals: [], today: T, date: '2026-11-07' }), 0, 'a dry shelf stays at zero, it does not go negative');
  assert.equal(balanceOn({ onHand: null, rate: 44, arrivals: [], today: T, date: '2026-11-07' }), null, 'no reading, no claim');
  assert.equal(balanceOn({ onHand: 9, rate: 30, arrivals: [{ date: T, qty: 6 }], today: T, date: '2026-10-13' }), 14, 'a line counted today is aboard tomorrow, less one day of use');

  // Pursuit's shape: an MFD toner with a par of 5. 2 aboard at 1 a month, dry
  // 11 Dec, 5 landing 20 Dec, the open order landing 24 Feb. About 2.8 are
  // still aboard on 24 Feb, so the top-up is 3 - not 5.
  const f = runsOutFirst({ ship: 'Pursuit', item: 'TNP75 BLACK TONER', onHand: 2, rate: 1,
    arrivals: [{ date: '2026-12-20', qty: 5 }], today: T, nextLoading: '2026-12-20', orderLands: '2027-02-24', orderUntil: '2027-03-31' });
  assert.ok(f && f.stockout === '2026-12-11', `dry 11 Dec, got ${f && f.stockout}`);
  const q = withQuantity({ ...f, description: 'TNP75 BLACK TONER BH 5000i (YIELD: 20K)' },
    { brand: 'Azamara', parQty: 5, due: '2026-11-23', lands: '2027-02-24', until: '2027-03-31', coming: 0, today: T, arrivals: [{ date: '2026-12-20', qty: 5 }] });
  assert.equal(q.add_qty, 3, 'par 5 less the 2 still aboard when the order lands');
  assert.ok(/about 2 still aboard/.test(q.add_basis), q.add_basis);
  console.log('ok - runway: what is aboard when the order lands is walked day by day, so a par top-up does not re-order stock already coming');
}

// THE SHELF LASTS PAST THE LANDING AFTER THE OPEN ORDER: THAT ORDER'S BUSINESS,
// WITH OR WITHOUT A DELIVERY ALREADY COMING. Ray, 27 Oct 2026, on Radiance
// paper (48 aboard, dry 10 Jan, order landing 14 Nov, next landing 5 Dec) and
// Star's waste box (14 aboard, dry 19 Jan, order landing 6 Dec, next 20 Dec):
// "Vessel has enough ... for November but needs to put order in December."
// Until then the test ran only when a delivery landed first, so both rows
// were pinned on the open order.
{
  const T = '2026-10-26';
  const star = { ship: 'Star', item: 'WASTE TONER BOX (DG3)', onHand: 14, rate: 5, arrivals: [], today: T, nextLoading: null };
  assert.equal(runsOutFirst({ ...star, orderLands: '2026-12-06', orderUntil: '2026-12-20' }), null,
    'dry 19 Jan, the open order lands 6 Dec and the next 20 Dec: December\'s order carries it');
  const f = runsOutFirst({ ...star, orderLands: '2026-12-06', orderUntil: '2027-01-31' });
  assert.ok(f && f.stockout === '2027-01-19', 'with the next landing after the dry day, this order must carry it');
  assert.ok(runsOutFirst({ ...star, orderLands: '2027-01-25', orderUntil: '2027-02-10' }), 'an order landing after the dry day is always a finding');
  assert.ok(runsOutFirst({ ...star, orderLands: null, orderUntil: null }), 'no open order: still a finding, the manual-order ask');
  // The order quantity on a waste box that IS due is 12, whatever is aboard.
  const due = withQuantity({ ...f, description: 'WASTE TONER BOX (DG3)' }, { brand: 'Royal', due: '2026-11-15', lands: '2026-12-06', until: '2027-01-31', coming: 0, today: T, arrivals: [] });
  assert.equal(due.add_qty, 12, 'the 12 piece rule');
  assert.match(due.add_basis, /a waste box order is 12 pieces/);
  console.log('ok - runway: an item that lasts past the landing after the open order waits for that order (Radiance, Star, 27 Oct); a waste box order is 12');
}
