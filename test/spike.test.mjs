// A month that looks mistyped is left out of the 3-month average (17 Nov 2026).
// spike.js is a TWIN of cims-hon consumption.js usageAnomaly()/usedInMonth():
// these are the cases HON's own tests pin, so the two apps agree on the month.
import assert from 'node:assert';
const { spikeOf, usedByMonth, skippedMonth, rateWithout } = await import('../src/lib/spike.js');

// Pursuit's shape: MAY 15, JUN 14, JUL 15, AUG 30, SEP 15, OCT 15. AUG is double the rest.
const pursuit = [['2026-04', 200], ['2026-05', 185], ['2026-06', 171], ['2026-07', 156], ['2026-08', 126], ['2026-09', 111], ['2026-10', 96]]
  .map(([month, on_hand]) => ({ month, on_hand, receipts: 0 }));
assert.deepEqual(usedByMonth(pursuit), { '2026-05': 15, '2026-06': 14, '2026-07': 15, '2026-08': 30, '2026-09': 15, '2026-10': 15 });
assert.equal(skippedMonth(pursuit, '2026-11'), '2026-08', 'a November run averages AUG, SEP, OCT: AUG is left out');
// A December run averages SEP, OCT, NOV: AUG is outside the three and nothing is skipped.
const later = [...pursuit, { month: '2026-11', on_hand: 81, receipts: 0 }];   // NOV used 15
assert.equal(skippedMonth(later, '2026-12'), null);
// Four measured months are too few to judge.
assert.equal(skippedMonth(pursuit.slice(2), '2026-11'), null);

// Last month itself is never skipped.
const lastSpike = [['2026-03', 215], ['2026-04', 200], ['2026-05', 185], ['2026-06', 171], ['2026-07', 156], ['2026-08', 141], ['2026-09', 111]]
  .map(([month, on_hand]) => ({ month, on_hand, receipts: 0 }));                // SEP used 30
assert.equal(skippedMonth(lastSpike, '2026-10'), null);

// Below 6, doubling is noise; a slow item is never flagged.
assert.equal(spikeOf([1, 1, 1, 4, 1, 1].map((used, k) => ({ month: `2026-0${k + 1}`, used }))), null);

// An export month carries its own opening count (HON usedInMonth).
assert.deepEqual(usedByMonth([{ month: '2026-10', on_hand: 17, receipts: 6, source: 'csv', opening: 22, xq: 4 }]), { '2026-10': 7 });

// The rate without the skipped month: the higher of last month and the clean average.
assert.deepEqual(rateWithout(15, '2026-07=15,2026-08=30,2026-09=15', '2026-08'), { avg: 15, months: 2, rate: 15 });
assert.deepEqual(rateWithout(12, '2026-07=15,2026-08=30,2026-09=15', null), { avg: 20, months: 3, rate: 20 });
assert.deepEqual(rateWithout(0, '2026-07=2,2026-08=2,2026-09=0', null).rate.toFixed(2), '1.33', 'a zero last month still falls to the average');

console.log('ok - spike: a month that looks mistyped (the twin of cims-hon usageAnomaly) is left out of the 3-month average; last month never is; the plan is the higher of last month and the clean average');
