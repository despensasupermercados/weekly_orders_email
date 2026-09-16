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
// ON QUANTITIES. The first version of this file refused to print one: par is
// what should be ABOARD and an order line is a different number, and the
// waste-box rule had already tripped that unit error once. That refusal was
// right for as long as the only rule in hand was a par. It is not the only rule
// any more. Ray answered the ordering questions in writing on 1 Sep and 4 Sep
// 2026 (Questions for Ray -RG09012026.docx; Ray_Questions_Round4 RG.docx), and
// every quantity below is one of his rules applied to one of his numbers. See
// orderQuantity() - each branch names its source. Nothing in here is estimated.

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

// ---------------------------------------------------------------------------
// HOW MUCH TO ADD. Ray's ordering rules, verbatim sources, one branch each.
//
// WHICH ORDER. Ray, 1 Sep 2026 Q21: the printer "looks at the order due date
// which is the physical date they have to process the order or it's missed."
// So a line can only be added to an order whose DUE DATE is still ahead. The
// first cut of this file aimed the quantity at the next container already in
// transit for the item - an order that closed months ago (Quest's 14 Oct
// container was due 3 Jul). Live data on 15 Sep: every in-transit landing
// matched a schedule row whose due date had passed. The quantity now targets
// the ship's next OPEN order (earliest due date on or after today), covers the
// stretch from THAT landing to the landing after it (cycleDays), less whatever
// the item already has on that order (coming).
//
//  PRINT-SHOP TONER (TN619 / TN634 for the C4070):
//    "Toners are based on consumption and based on statistics the required
//     amount is ordered ... order 3 toners over their consumption amount ...
//     a safety net in case you print a little bit more."  - Ray, 1 Sep 2026 Q20
//    The +3/+4 was NOT a nationality rule; the Brain corrected that on 7 Sep
//    (all open ports are +3, and the buffer follows delivery frequency)
//    [recN47v4lrTkjQNpO]. Until the 192-port transit table is parsed, +3 is the
//    one figure that is sourced for every open port. It is the only buffer used.
//  WASTE TONER BOX (C4070): 12 IS A PAR, NOT AN ORDER QUANTITY.
//    "the exact order is 12 pieces per ship from all brands" - Ray, 4 Sep Q7;
//    "12 base, 24 permitted on high volume" - Ray, round 9 [recGzzU4LphovQ1ne].
//    The Brain corrected the reading on 10 Sep 2026 [recN47v4lrTkjQNpO]: 12 is
//    what should be ABOARD, and comparing an order line to it is a unit error.
//    So the waste box is a top-up to 12, like the MFD par rule - and this file
//    repeated the corrected error once before the corrections field was read.
//    A later Brain record beats an earlier document.
//  20 LB PAPER, Royal and Celebrity:
//    "always ordered in a pallet of 40 cases" - Ray, 1 Sep Q19. Paper has no
//    par; 40 is the order set.
//  20 LB PAPER, Azamara (and Azamara card stock / gloss text):
//    "Azamara it's based on strict consumption due to space so they could not
//     accept 40 cases rather what they use." - Ray, 1 Sep Q19.
//  RADIANT WHITE (Celebrity maps):
//    "minimum of 10 cases ... if a ship needs 14 cases, they can order the 14"
//    - Ray, 1 Sep Q20 and 4 Sep Q8.
//  AZAMARA MFD TONER and MFD waste bottles (TN324, TN514, TNP48, TNP75, TNP79,
//  TN-328, WX-103, WB-P05):
//    "they have a par level assigned on OBP, we follow this par level and
//     replenish only as needed" - Ray, 4 Sep Q1. Top-up to par.
// ---------------------------------------------------------------------------

export const TONER_BUFFER = 3;      // Ray Q20 + Brain 7 Sep: +3 at every open port
export const WASTE_BOX_PAR = 12;    // Ray 4 Sep Q7 + round 9; a PAR per the Brain, 10 Sep
export const PAPER_PALLET = 40;     // Ray 1 Sep Q19, Royal and Celebrity only
export const RADIANT_MIN = 10;      // Ray 1 Sep Q20

const PRINT_SHOP_TONER = /\bTN(619|634)[A-Z]?\b/i;
const MFD_TONER = /\b(TN324|TN514|TNP48|TNP75|TNP79|TN-?328)/i;
const WASTE_BOX_C4070 = /WASTE TONER BOX \(DG3\)/i;
const MFD_WASTE = /WX-103|WB-P05|WASTE TONER BOTTLE|WASTE TONER BOX$/i;
const PAPER_20LB = /20 LBS .* PAPER/i;
const RADIANT = /RADIANT/i;
const AZAMARA_STOCK = /CARD STOCK|GLOSS TEXT/i;

const ceil = (n) => Math.max(0, Math.ceil(n - 1e-9));

// Returns { qty, basis } or null when no sourced rule applies to the item.
// qty is what to ADD to the open order. inTransit is what the item already has
// on that order; onHandAtLanding is what will still be aboard the day it lands
// (zero for a true stockout, more when the order arrives before the item runs
// dry) - it matters only to the par rule, which is a top-up.
export function orderQuantity({ item, brand, rate, inTransit = 0, cycleDays = MONTH_DAYS, parQty = null, onHandAtLanding = 0 }) {
  const desc = String(item || '');
  const azamara = /azamara/i.test(String(brand || ''));
  const need = ceil((Number(rate) || 0) * (cycleDays / MONTH_DAYS)); // units used until the next landing
  const coming = Number(inTransit) || 0;
  const left = Math.max(0, Math.floor(Number(onHandAtLanding) || 0));

  if (WASTE_BOX_C4070.test(desc)) {
    const aboard = left > 0 ? `, about ${left} still on board when it lands` : '';
    return { qty: Math.max(0, WASTE_BOX_PAR - left - coming), basis: `waste box par is ${WASTE_BOX_PAR}${aboard}` };
  }
  if (PRINT_SHOP_TONER.test(desc)) {
    return { qty: Math.max(0, need + TONER_BUFFER - coming), basis: `${need} used in ${cycleDays} days + ${TONER_BUFFER} spare` };
  }
  if (MFD_TONER.test(desc) || MFD_WASTE.test(desc)) {
    if (parQty == null) return null; // Ray: MFD lines follow the OBP par; no par, no number
    const par = Number(parQty);
    // A par below one cycle's usage is a par problem, not an ordering problem.
    // Print the rule's number and say how long it lasts, so the reader can see
    // the par is short instead of trusting a figure that runs out in days.
    const lasts = rate > 0 ? Math.round(par / (Number(rate) / MONTH_DAYS)) : null;
    const short = lasts != null && lasts < cycleDays ? ` (${par} lasts about ${lasts} days at your usage)` : '';
    const aboard = left > 0 ? `, about ${left} still aboard when it lands` : '';
    return { qty: Math.max(0, par - left - coming), basis: `OBP par is ${par}${aboard}${short}` };
  }
  if (RADIANT.test(desc)) {
    if (coming >= need) return { qty: 0, basis: 'already on the way' };
    return { qty: Math.max(RADIANT_MIN, need - coming), basis: `${need} used in ${cycleDays} days, minimum ${RADIANT_MIN} cases` };
  }
  if (PAPER_20LB.test(desc)) {
    if (azamara) return { qty: Math.max(0, need - coming), basis: `${need} cases used in ${cycleDays} days` };
    if (coming >= need) return { qty: 0, basis: 'a pallet is already on the way' };
    return { qty: PAPER_PALLET, basis: `paper is one pallet of ${PAPER_PALLET} cases` };
  }
  if (AZAMARA_STOCK.test(desc)) {
    return { qty: Math.max(0, need - coming), basis: `${need} used in ${cycleDays} days` };
  }
  return null;
}

// Attach the order and the quantity to a RUNS_OUT finding.
//   due / lands  - the ship's next OPEN order: its due date and the date it is
//                  on board (Ray Q21's two dates). Both null when no order is
//                  open, or the ship has no ordering schedule loaded.
//   until        - the landing after `lands`, so the order covers one full
//                  cycle; absent, one month.
//   coming       - what the item already has on that order.
//   today, arrivals - to project what is still aboard the day the order lands.
export function withQuantity(finding, { brand, parQty, due = null, lands = null, until = null, coming = 0, today = null, arrivals = [] }) {
  if (!finding) return finding;
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const cycleDays = lands && until && until > lands ? daysBetween(lands, until) : MONTH_DAYS;
  // What is aboard when the order lands: nothing if the item is dry by then,
  // otherwise today's stock less usage to that day, plus anything landing first.
  let onHandAtLanding = 0;
  if (lands && today && finding.stockout && lands < finding.stockout) {
    const used = (Number(finding.rate) || 0) * (daysBetween(today, lands) / MONTH_DAYS);
    const early = (arrivals || []).filter((a) => a.date >= today && a.date < lands)
      .reduce((n, a) => n + (Number(a.qty) || 0), 0);
    onHandAtLanding = Math.max(0, (Number(finding.on_hand) || 0) + early - used);
  }
  const q = orderQuantity({ item: finding.item, brand, rate: finding.rate, inTransit: coming, cycleDays, parQty, onHandAtLanding });
  return {
    ...finding,
    order_due: due || null,
    order_lands: lands || null,
    on_order: Number(coming) || 0,
    cover_to: lands && until && until > lands ? until : null,
    cycle_days: cycleDays,
    add_qty: q ? q.qty : null,
    add_basis: q ? q.basis : null,
  };
}

// DEADLINE ORDER for RUNS_OUT findings. Miguel, 15 Sep 2026: "always filter by
// the due date on these emails." No open order (nothing to add to, a manual
// order to ask for today) sorts first; then the earliest due date; then the
// day the item runs dry; then ship and item so the order is stable.
export function byDueDate(a, b) {
  const da = a.order_due || '', db = b.order_due || '';
  if (da !== db) return da < db ? -1 : 1;
  const sa = a.stockout || '', sb = b.stockout || '';
  if (sa !== sb) return sa < sb ? -1 : 1;
  const ka = `${a.ship}|${a.item}`, kb = `${b.ship}|${b.item}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
