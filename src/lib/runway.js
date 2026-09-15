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
// The item in question has ALREADY RUN OUT before this container lands - that is
// what a RUNS_OUT finding means - so what is aboard when it lands is nothing.
// The quantity therefore covers the stretch from THIS landing to the NEXT one
// (cycleDays), less whatever is already on that container (inTransit).
//
//  PRINT-SHOP TONER (TN619 / TN634 for the C4070):
//    "Toners are based on consumption and based on statistics the required
//     amount is ordered ... order 3 toners over their consumption amount ...
//     a safety net in case you print a little bit more."  - Ray, 1 Sep 2026 Q20
//    The +3/+4 was NOT a nationality rule; the Brain corrected that on 7 Sep
//    (all open ports are +3, and the buffer follows delivery frequency)
//    [recN47v4lrTkjQNpO]. Until the 192-port transit table is parsed, +3 is the
//    one figure that is sourced for every open port. It is the only buffer used.
//  WASTE TONER BOX (C4070):
//    "the exact order is 12 pieces per ship from all brands" - Ray, 4 Sep Q7;
//    "12 base, 24 permitted on high volume" - Ray, round 9 [recGzzU4LphovQ1ne].
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
export const WASTE_BOX_ORDER = 12;  // Ray 4 Sep Q7
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
// qty is what to ADD to the order landing on the finding's next_loading.
export function orderQuantity({ item, brand, rate, inTransit = 0, cycleDays = MONTH_DAYS, parQty = null }) {
  const desc = String(item || '');
  const azamara = /azamara/i.test(String(brand || ''));
  const need = ceil((Number(rate) || 0) * (cycleDays / MONTH_DAYS)); // units used until the next landing
  const coming = Number(inTransit) || 0;

  if (WASTE_BOX_C4070.test(desc)) {
    return { qty: Math.max(0, WASTE_BOX_ORDER - coming), basis: `waste box is ${WASTE_BOX_ORDER} per order` };
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
    return { qty: Math.max(0, par - coming), basis: `OBP par is ${par}${short}` };
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

// Attach the quantity to a RUNS_OUT finding. nextAfter is the landing after
// next_loading (so the order covers one full cycle); absent, one month.
export function withQuantity(finding, { brand, parQty, inTransit, nextAfter }) {
  if (!finding) return finding;
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const cycleDays = finding.next_loading && nextAfter && nextAfter > finding.next_loading
    ? daysBetween(finding.next_loading, nextAfter)
    : MONTH_DAYS;
  const q = orderQuantity({ item: finding.item, brand, rate: finding.rate, inTransit, cycleDays, parQty });
  return {
    ...finding,
    cover_to: finding.next_loading && nextAfter && nextAfter > finding.next_loading ? nextAfter : null,
    cycle_days: cycleDays,
    add_qty: q ? q.qty : null,
    add_basis: q ? q.basis : null,
  };
}
