// The schedule-free check.
//
// WHY THIS EXISTS, IN MIGUEL'S OWN WORDS [recOxbIZytNBd64AM, 9 Sep 2026]:
//
//   "The check must degrade gracefully. A ship with no ordering schedule still
//    gets whatever warning the open-orders data supports, clearly labelled as
//    such. It must never fall silent just because one input is missing -
//    SILENCE IS EXACTLY HOW AN ORDER GETS FORGOTTEN AND AN EMERGENCY SHIPMENT
//    GETS PAID."
//
// The weekly email was built on schedule_order alone and so covered 23 of 48
// ships. The other 25 received nothing at all, which is indistinguishable from
// "nothing is due for you" - the precise failure the objective names. All 48
// are present in obp_intransit, so the data to warn them has been there the
// whole time.
//
// WHAT IT CAN SEE WITHOUT A SCHEDULE. Not the due date - that lives only in the
// ordering schedule. But it can see every delivery a ship already has coming,
// and therefore the GAPS BETWEEN THEM. A gap materially longer than that ship's
// own rhythm is a loading nobody ordered against.
//
// JUDGED AGAINST THE SHIP, NOT THE FLEET [recORkTFI9TxzQ0LK]: "ships use every
// OTHER biweekly loading", the ordered loadings "sit 25-28 DAYS APART", and a
// miss is "a GAP LONGER THAN THE SHIP'S OWN NORMAL INTERVAL, not an eligible
// voyage with no order". So the threshold is that ship's median interval, with
// a floor - never one number applied to 48 different rhythms.
//
// THIS IS WEAKER EVIDENCE THAN THE SCHEDULE PATH AND MUST SAY SO. It cannot
// name a due date, so it can never say "order by". It says "there is a gap
// here, is that deliberate" - a question, to a person who knows the answer.
// Dressing a question as an instruction is how this email would lose its
// authority in one send.

import { require_, firstPresent } from './schema.js';

// Below this, a gap is ordinary biweekly rhythm and not worth a word.
export const MIN_GAP_DAYS = 35;
// A gap this much longer than the ship's own median is the ship breaking its
// own pattern, which is the only pattern that means anything here.
export const GAP_MULTIPLE = 1.5;

export const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

// deliveries: [{ ship, date }] - one row per distinct delivery date per ship.
// Returns a finding per gap that breaks the ship's own rhythm, future only.
export function gapFindings(deliveries, today, opts = {}) {
  const minGap = opts.minGap ?? MIN_GAP_DAYS;
  const mult = opts.multiple ?? GAP_MULTIPLE;

  const byShip = new Map();
  for (const d of deliveries) {
    if (!d || !d.ship || !d.date) continue;
    if (!byShip.has(d.ship)) byShip.set(d.ship, new Set());
    byShip.get(d.ship).add(String(d.date));
  }

  const out = [];
  for (const [ship, set] of byShip) {
    const dates = [...set].sort();
    if (dates.length < 3) continue; // two points is not a rhythm
    const gaps = [];
    for (let i = 1; i < dates.length; i++) gaps.push(days(dates[i], dates[i - 1]));
    const own = median(gaps);
    const threshold = Math.max(minGap, Math.round(own * mult));

    for (let i = 1; i < dates.length; i++) {
      const gap = gaps[i - 1];
      // Future only. A gap that has already passed cannot be acted on, and the
      // due date for it is long gone - telling a crew about it is the nagging
      // that gets this email filtered.
      if (dates[i] < today || gap <= threshold) continue;
      out.push({
        ship,
        severity: 'warn',
        code: 'DELIVERY_GAP',
        after_delivery: dates[i - 1],
        next_delivery: dates[i],
        gap_days: gap,
        own_interval: own,
        basis: 'open orders only - no ordering schedule loaded for this ship',
        detail: `nothing arrives between ${dates[i - 1]} and ${dates[i]}, a ${gap}-day gap ` +
          `against this ship's usual ${own} days. If a loading in between was meant to be ` +
          `ordered, it has not been.`,
      });
    }
  }

  out.sort((a, b) => (b.gap_days - a.gap_days) || (a.next_delivery < b.next_delivery ? -1 : 1));
  return out;
}

// ---- the database side ----
//
// Resolve columns rather than assume them, and refuse rather than return an
// empty list: an empty list here reads as "all 25 ships are fine", which is the
// same silence this module exists to remove.

const ETA_COLS = ['eta'];
const ELIGIBLE = `(
     UPPER(REPLACE(REPLACE(mot,'-',''),' ','')) LIKE 'HOTELBIWEEKLYHOTEL%'
  OR UPPER(REPLACE(REPLACE(mot,'-',''),' ','')) LIKE 'HOTELMONTHLY%'
  OR mot = 'AZAMARA BWS')`;

export async function unscheduledGaps(hon, today, opts = {}) {
  const probe = await require_(hon, 'obp_intransit', ['ship', 'snapshot_date']);
  if (!probe.ok) return { ran: false, reason: probe.reason, findings: [], ships: 0 };
  const etaCol = firstPresent(probe.columns, ETA_COLS);
  if (!etaCol) {
    return {
      ran: false, findings: [], ships: 0,
      reason: `obp_intransit has no recognisable eta column (looked for ${ETA_COLS.join(', ')}). ` +
        `The schedule-free check is UNKNOWN, not clean.`,
    };
  }

  // eta is an Excel serial in a TEXT column. Reading it as a string matched
  // nothing silently once and produced a confident wrong count.
  const rows = (await hon.prepare(`
    SELECT DISTINCT ship,
           date('1899-12-30', '+' || CAST(${etaCol} AS INTEGER) || ' days') AS date
      FROM obp_intransit
     WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM obp_intransit)
       AND ${etaCol} GLOB '[0-9]*'
       AND ship NOT IN (SELECT DISTINCT ship FROM schedule_order WHERE ${ELIGIBLE})
     ORDER BY ship, date`).all()).results || [];

  if (!rows.length) {
    return {
      ran: false, findings: [], ships: 0,
      reason: 'no in-transit rows for any ship without an ordering schedule - either every ship ' +
        'has a schedule, or the OBP feed is empty. Both are worth knowing; neither is "clean".',
    };
  }

  const ships = new Set(rows.map((r) => r.ship)).size;
  return { ran: true, reason: null, ships, findings: gapFindings(rows, today, opts) };
}
