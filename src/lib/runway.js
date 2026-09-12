// Will this ship run out before its next container lands?
//
// THIS IS THE QUESTION THE EMAIL WAS NOT ASKING. It knew whether an order
// existed for a loading. It did not know whether the ship had anything left.
// Those are different questions and only the second one costs money:
//
//   "You have an order coming Wednesday, and you're going to run out of black
//    toner. You either fix it now, or you wait until the next biweekly order."
//                                                       - Miguel, 11 Sep 2026
//
// Adding a line to an order that has not closed is free. Missing it means the
// ship runs dry and waits ~28 days for the next loading, or somebody pays
// emergency freight - which is the whole objective [recOxbIZytNBd64AM].
//
// THE CONSUMPTION FORMULA IS RAY'S, NOT MINE [recQ2a7KrEQhosimV], verified on
// every row of the statistics file:
//
//   Usage Consumption = Beginning Inventory + Inventory Additions - Ending
//
// which over the monthly snapshots is on_hand(prev) + receipts(m) - on_hand(m).
// Checked against Onward cyan: Jun 7, Jul 7, Aug 7 a month. It holds.
//
// THE RATE IS THE GREATER OF LAST MONTH OR THE 3-MONTH AVERAGE - Ray's SOP, and
// deliberately the pessimistic of the two. Under-ordering strands a ship;
// over-ordering costs shelf space.
//
// WHAT THIS IS NOT. It does not compute an order quantity. Par is what should be
// ABOARD and an order line is a different number; the waste-box rule already
// tripped that unit error once. This reports a DATE - the day the balance
// crosses zero - which is a fact the crew can act on without anyone signing off
// on arithmetic they did not write.

// The consumables the fleet actually orders [recQ2a7KrEQhosimV]. Matched on the
// description, never a part number: the black toner part number already changed
// once (TN619K -> TN634K) and hardcoding it would have silently dropped black
// from every ship on the newer machine.
const CONSUMABLE = /\b(toner|paper|card stock|gloss text|radiant white|report)\b/i;
// A waste box is consumed too, but it is a par item and not a print consumable;
// it is kept because running out of one stops the press just as hard.
export const isConsumable = (description) => CONSUMABLE.test(String(description || ''));

export const MONTH_DAYS = 30;

// snapshots: [{ month:'2026-08', on_hand, receipts }] for ONE (ship, part).
// Returns monthly usage, oldest first. The current month is excluded: it is
// half-counted and reads as a collapse in consumption.
export function monthlyUsage(snapshots, currentMonth) {
  const rows = snapshots
    .filter((s) => s && s.month && s.month < currentMonth)
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const used = Number(rows[i - 1].on_hand || 0) + Number(rows[i].receipts || 0) - Number(rows[i].on_hand || 0);
    // Negative usage is a data fault, not a negative burn - most often the
    // Pursuit failure mode, a mistyped ending inventory. Drop it rather than
    // let it pull the average down and hide a real stockout.
    if (Number.isFinite(used) && used >= 0) out.push({ month: rows[i].month, used });
  }
  return out;
}

// Ray's SOP: the greater of last month or the trailing 3-month average.
export function burnRate(usage) {
  if (!usage.length) return null;
  const last = usage[usage.length - 1].used;
  const tail = usage.slice(-3);
  const avg = tail.reduce((a, u) => a + u.used, 0) / tail.length;
  return Math.max(last, avg);
}

const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);

// Walks the balance forward a day at a time, adding each arrival on its date.
// Returns the first date the balance would hit zero, or null if it never does
// inside the horizon.
export function stockoutDate({ onHand, rate, arrivals = [], today, horizonDays = 120 }) {
  if (!rate || rate <= 0) return null;             // no measured burn, no claim
  const daily = rate / MONTH_DAYS;
  const due = new Map();
  for (const a of arrivals) {
    if (!a || !a.date || !Number.isFinite(Number(a.qty))) continue;
    due.set(a.date, (due.get(a.date) || 0) + Number(a.qty));
  }
  let bal = Number(onHand || 0);
  for (let i = 0; i <= horizonDays; i++) {
    const day = addDays(today, i);
    bal += due.get(day) || 0;
    if (bal <= 0) return day;
    bal -= daily;
  }
  return null;
}

// THE FINDING. An item runs out BEFORE the next delivery that could have
// carried it - so the fix is to add it to an order that is still open, and the
// cost of missing it is a full cycle.
export function runsOutFirst({ ship, item, onHand, rate, arrivals, today, nextLoading, horizonDays }) {
  const out = stockoutDate({ onHand, rate, arrivals, today, horizonDays });
  if (!out) return null;
  // Something already arrives on or before the day it would run dry: covered.
  const covered = (arrivals || []).some((a) => a.date <= out && Number(a.qty) > 0 && a.date >= today);
  if (covered) return null;
  return {
    ship, item,
    code: 'RUNS_OUT',
    severity: out <= (nextLoading || out) ? 'critical' : 'warn',
    on_hand: Number(onHand || 0),
    rate: Math.round(rate * 10) / 10,
    stockout: out,
    next_loading: nextLoading || null,
    detail: `${item}: ${Number(onHand || 0)} on board, using about ${Math.round(rate)} a month. ` +
      `Runs out around ${out}` +
      (nextLoading ? `, and the next loading after that is ${nextLoading}.` : '.'),
  };
}
