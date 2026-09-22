// node test/anomaly.test.mjs
// The Pursuit case: one keystroke, eight days undetected, a near-miss air
// freight to Japan. The number was not extreme, it was extreme FOR THAT SHIP,
// so every assertion here is about comparing a ship against its own history.

import { judgeSeries, findAnomalies, median, mad } from '../src/lib/anomaly.js';
import assert from 'node:assert';

const day = (n) => `2026-09-${String(n).padStart(2, '0')}`;
const series = (...vals) => vals.map((value, i) => ({ date: day(i + 1), value }));

assert.equal(median([3, 1, 2]), 2);
assert.equal(median([4, 1, 2, 3]), 2.5);
assert.equal(mad([10, 10, 10, 10]), 0, 'a flat series has zero spread');

// A slipped digit: 12 becomes 120. This is the shape the Pursuit error had.
const slip = judgeSeries(series(12, 11, 12, 13, 12, 11, 120));
assert.equal(slip.verdict, 'digit_slip');
assert.equal(slip.latest.value, 120);
assert.equal(slip.base, 12, 'the suspect reading must not vote on its own baseline');

// Ordinary movement is silence. An anomaly mail that cries wolf is filtered
// inside a month and then the real one is invisible too.
assert.equal(judgeSeries(series(12, 11, 12, 13, 12, 11, 14)).verdict, 'normal');
assert.equal(judgeSeries(series(100, 104, 96, 101, 99, 103, 108)).verdict, 'normal');

// A count cannot be negative. That is arithmetic, not statistics.
const neg = judgeSeries(series(5, 6, 5, 6, 5, 6, -3));
assert.equal(neg.verdict, 'impossible');

// TOO LITTLE HISTORY IS NOT A CLEAN RESULT. Judging a ship on two readings is
// how a check produces a confident wrong answer.
const thin = judgeSeries(series(4, 400));
assert.equal(thin.verdict, 'no_baseline');
assert.equal(thin.points, 2);

// A MEAN AND A STANDARD DEVIATION WOULD MISS THIS. Two bad readings drag a mean
// far enough that neither looks unusual. The median does not move.
const twoBad = judgeSeries(series(10, 10, 10, 10, 10, 900, 900));
assert.notEqual(twoBad.verdict, 'normal', 'a repeated bad reading must still be caught');

// HOW LONG IT HAS BEEN WRONG is the number that mattered on Pursuit. Not that
// the figure was bad, but that it stood for eight days and nothing said so.
const standing = judgeSeries([
  ...series(10, 10, 10, 10, 10, 10),
  { date: '2026-09-07', value: 900 },
  { date: '2026-09-08', value: 900 },
  { date: '2026-09-09', value: 900 },
]);
assert.equal(standing.since.snapshots, 3);
assert.equal(standing.since.first_seen, '2026-09-07');
assert.ok(String(standing.detail).includes('900'));

// Fleet roll-up: each (ship, item) is judged alone, and a series too short to
// judge is counted, never reported as healthy.
const rows = [
  ...series(12, 11, 12, 13, 12, 11, 120).map((p) => ({ ship: 'Pursuit', item: 'TONER CYAN', ...p })),
  ...series(8, 8, 9, 8, 9, 8, 9).map((p) => ({ ship: 'Quest', item: 'TONER CYAN', ...p })),
  ...series(3, 4).map((p) => ({ ship: 'Onward', item: 'TONER CYAN', ...p })),
];
const roll = findAnomalies(rows);
assert.equal(roll.findings.length, 1, 'only Pursuit is anomalous');
assert.equal(roll.findings[0].ship, 'Pursuit');
assert.equal(roll.judged, 2);
assert.equal(roll.no_baseline, 1, 'Onward is unjudged, and that is reported as unjudged');

console.log('ok - anomalies: a slipped digit is caught against the ship\'s own median,');
console.log('     ordinary movement stays silent, and thin history is never called clean');

// ---------------------------------------------------------------------------
// MEASURED AGAINST THE LIVE FLEET, 21 Sep 2026. The night check was raising 71
// anomalies; 64 were `digit_slip` and 61 of those were an item reaching ZERO,
// 58 of them having moved by fewer than five units. Miguel: "I hate that
// email." The two rules below took the same 1,200 live series from 71 to 5.
{
  // ZERO IS A STOCKOUT, NOT A TYPO. ratio = 0/base = 0, and 0 is always
  // <= 1/8, so every shelf that ran to nothing was called a mistyped digit.
  const toZero = judgeSeries(series(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0));
  assert.equal(toZero.verdict, 'normal', 'an item running down to zero is not a typo');

  const toZeroBigger = judgeSeries(series(4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 0));
  assert.equal(toZeroBigger.verdict, 'normal', 'nor is a four-unit shelf reaching zero');

  // THE FLOOR NOW APPLIES HERE TOO. A one-unit move cannot be a slipped digit.
  assert.equal(judgeSeries(series(1, 1, 1, 1, 1, 1, 1, 9)).verdict, 'digit_slip',
    'a real proportional jump with units behind it still fires');
}

{
  // A HISTORY OF ZEROS IS NOT A BASELINE. Legend, six months out of service,
  // raised four of these a night from the day it came back.
  const returning = judgeSeries(series(0, 0, 0, 0, 0, 0, 20, 19, 12, 38, 35));
  assert.equal(returning.verdict, 'no_baseline',
    'a ship returning to service has no usable baseline, and we say so');

  // An item that has genuinely always been empty is untouched: max is 0, so
  // the zero-baseline rule does not fire and a real first delivery still shows.
  const firstEver = judgeSeries(series(0, 0, 0, 0, 0, 0, 0, 0, 0, 30));
  assert.notEqual(firstEver.verdict, 'normal', 'a first delivery onto an empty shelf is still news');
}

{
  // THE FOUNDING CASE MUST SURVIVE ALL OF IT. One keystroke, 12 -> 120.
  const pursuit = judgeSeries(series(12, 11, 12, 13, 12, 11, 12, 120));
  assert.equal(pursuit.verdict, 'digit_slip', 'the Pursuit keystroke is still caught');
  // And the same error downward.
  const down = judgeSeries(series(120, 119, 121, 118, 122, 120, 119, 12));
  assert.equal(down.verdict, 'digit_slip', 'a digit slipped the other way is still caught');
}

console.log('ok - anomaly: a shelf reaching zero is a stockout not a typo, a ship out of service has no baseline, and the Pursuit keystroke still fires');
