// The database half of the runway check. Kept apart from runway.js so the
// arithmetic stays testable without a database, which is how Ray's consumption
// formula got pinned against Onward's real figures.
//
// It resolves its columns and refuses rather than returning an empty list: an
// empty list here reads as "no ship will run out", which is the most expensive
// wrong answer this email could give.

import { inService } from './fleetStatus.js';
import { require_, columnsOf } from './schema.js';
import { runsOutFirst, withQuantity, byDueDate, isFloorModel, FLOOR_MODEL_MONTHS } from './runway.js';
import { obpSource, CSV_CONSUMPTION } from './obpSource.js';

// The consumables the fleet orders [recQ2a7KrEQhosimV]. Matched on description:
// the black toner part number already changed once (TN619K -> TN634K) and a
// hardcoded list would have silently dropped black from the newer presses.
// The NOT LIKEs remove the machine parts that merely carry the word "paper".
const ITEM_FILTER = `(
      p.description LIKE '%TONER%' OR p.description LIKE '%PAPER%'
   OR p.description LIKE '%CARD STOCK%' OR p.description LIKE '%GLOSS%'
   OR p.description LIKE '%RADIANT%')
  AND p.description NOT LIKE '%FEED%'
  AND p.description NOT LIKE '%ROLLER%'
  AND p.description NOT LIKE '%KIT%'`;

export const HORIZON_DAYS = 120;

// THE USAGE WE PLAN ON IS LAST MONTH'S. Ray, 12 Oct 2026, in writing: "the
// usage used was from last month". His projection sheets agree on 42 of 44
// rows. From 11 Sep to 12 Oct this was the higher of last month and the
// average, quoted to him as his SOP; it was never his practice, and it
// inflated Solstice's radiant (11 against his 7) and Freedom's yellow toner
// (5 against his 3), both rows he struck out of the 12 Oct email.
// The average stands in when last month cannot be measured (no reading for
// the month before it, or a negative figure dropped as a typo) AND when last
// month reads ZERO for an item the ship used before. Ray confirmed this on
// 13 Oct ("correct"), asked about Quest's WX-103 waste box: 0 aboard on
// 12 Oct, used 2 in July, 2 in August, 0 in September. Planning on zero would
// have removed it from the email when stock was lowest.
const RATE = 'COALESCE(NULLIF(a.lastm, 0), a.avg3)';

// FLOOR-MODEL TONER IS PLANNED ON SIX MONTHS, NOT ONE. Ray, 22 Oct 2026, asked
// whether floor-model toner and waste bottles (TN324, TN514, TNP75, TNP79,
// TN-328, WX-103) should plan on the 6-month average while paper and C4070
// toner stay on last month: "yes. six month average would work better for the
// floor models toners."
// Why: they move one or two a month, so one month is noise. His 19 Oct spot
// check of the email called 14 such rows okay at about 1 a month where we had
// planned on OBP's last month, 2 to 5. Quest TN324BK, September: OBP said 4
// used, the counts said 1 (4 aboard + 2 received - 5 aboard).
// The figure is the counts over the six complete months: the count at the end
// of the month before them, plus every receipt, less the count at the end of
// last month, over 6. Unlike an average of monthly figures it cannot be
// inflated by a receipt booked in one month and shelved in the next: both
// ends are counts, so the slip cancels. Measured on the 19 Oct data before it
// was built: 26 rows became 18, all five gaps Ray confirmed still showed, and
// no row appeared that was not there before.
// It needs all seven month-end counts. Without them (an item new to the ship,
// WX-103 with four months on file), or when the window nets to zero or less
// (a miscount), the item stays on the rule above: a hole in the history is
// never read as a ship that stopped printing.
const SIX_MONTHS = FLOOR_MODEL_MONTHS;

// Which schedule rows carry an order the ship can add to. The same three
// clauses as due.js and fallback.js; `t` is the schedule_order alias.
const eligible = (t) => `(
      UPPER(REPLACE(REPLACE(${t}.mot,'-',''),' ','')) LIKE 'HOTELBIWEEKLYHOTEL%'
   OR UPPER(REPLACE(REPLACE(${t}.mot,'-',''),' ','')) LIKE 'HOTELMONTHLY%'
   OR ${t}.mot = 'AZAMARA BWS')`;

export async function fleetRunway(hon, today, opts = {}) {
  // THE FRESHER COPY OF OBP. The workbook mirror (obp_*) or this Worker's own
  // CSV copy (weekly_obp_*), whichever carries the newer snapshot. See
  // obpSource.js for why the mirror alone was not enough.
  const src = await obpSource(hon);
  for (const [table, cols] of [
    ['consumption_snapshot', ['ship', 'part_number', 'month', 'on_hand', 'receipts']],
    [src.inventory.table, ['ship', 'part_number', 'on_hand', 'snapshot_date']],
    [src.intransit.table, ['ship', 'part_number', src.intransit.etaCol, 'qty', 'snapshot_date']],
    ['par', ['ship', 'part_number', 'description']],
    ['schedule_order', ['ship', 'mot', 'due_date', 'loading_delivery_date']],
  ]) {
    const probe = await require_(hon, table, cols);
    if (!probe.ok) return { ran: false, reason: probe.reason, findings: [], measured: 0 };
  }
  // The loading port sets the print-shop toner spare (+3 or +4, runway.js
  // tonerSpare). Without the column every order gets the +3 floor; the run
  // itself does not depend on it.
  const hasPort = Boolean((await columnsOf(hon, 'schedule_order'))?.has('loading_port'));

  // MONTH ARITHMETIC ON INTEGERS, NOT ON A DATE. setUTCMonth(-1) on the 31st
  // rolls forward into the same month (31 Mar - 1 -> 3 Mar), so on a month-end
  // run prevMonth equalled the current month and last month's usage was never
  // found. Found in code review, 16 Sep 2026.
  const monthsBack = (ym, n) => {
    const [y, m] = String(ym).slice(0, 7).split('-').map(Number);
    const idx = y * 12 + (m - 1) - n;
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  };
  const month = String(today).slice(0, 7);
  const fromMonth = monthsBack(month, 4);

  // OBP'S OWN FIGURE FOR LAST MONTH, WHEN WE HAVE IT. Ray's monthly export
  // (14 Oct 2026, September, three files by brand) is what he plans on. Our
  // count-derived figure matched it on 400 of 419 consumable rows; the rest
  // differed on receipts the stale workbook never carried (Quest, Spectrum,
  // Infinity), one wrong August count (Pursuit), and five rows where OBP
  // subtracts something its counts do not show (Ascent, Brilliance x2,
  // Constellation 10 low; Silhouette radiant 15 low). So OBP's number wins
  // where it exists, the computed one stands in where it does not, and the
  // email says which it used. Absent table: the computed figure, as before.
  const haveObp = Boolean(await columnsOf(hon, CSV_CONSUMPTION));
  const obpm = haveObp
    ? `SELECT ship, part_number, usage FROM ${CSV_CONSUMPTION} WHERE month = ?3`
    : `SELECT NULL ship, NULL part_number, NULL usage WHERE 0`;

  // Usage per month is Ray's formula, computed in SQL because the alternative
  // is pulling three years of snapshots for 48 ships into a Worker.
  // A negative usage is a mistyped ending inventory (the Pursuit failure) and
  // is dropped here rather than allowed to drag an average down.
  const sql = `
    WITH cons AS (
      SELECT c.ship, c.part_number, c.month, c.on_hand, c.receipts,
             LAG(c.on_hand) OVER (PARTITION BY c.ship, c.part_number ORDER BY c.month) prev,
             LAG(c.month) OVER (PARTITION BY c.ship, c.part_number ORDER BY c.month) prev_month
        FROM consumption_snapshot c
       WHERE c.month < ?1 AND c.month >= ?2
    ), used AS (
      -- THE PREVIOUS ROW MUST BE THE PREVIOUS MONTH. LAG takes the row before,
      -- whatever month it is: with July missing, August's "usage" would be
      -- June's count plus August's receipts minus August's count - two months
      -- of use less July's receipts, read as one month. A comment here used to
      -- claim such a row "drops out as well"; it did not. Now it does.
      -- (No gap in the data on 13 Oct 2026: 10,106 of 10,106 pairs consecutive.)
      SELECT ship, part_number, month, (prev + receipts - on_hand) u
        FROM cons
       WHERE prev IS NOT NULL AND (prev + receipts - on_hand) >= 0
         AND (CAST(substr(month, 1, 4) AS INTEGER) * 12 + CAST(substr(month, 6, 2) AS INTEGER))
           - (CAST(substr(prev_month, 1, 4) AS INTEGER) * 12 + CAST(substr(prev_month, 6, 2) AS INTEGER)) = 1
    ), agg0 AS (
      -- HOW MANY MONTHS THE AVERAGE IS ACTUALLY MADE OF.
      --
      -- avg3 is not always three. A month is only measurable when the month
      -- BEFORE it is inside the window too, because usage needs a previous
      -- on-hand to subtract from (the LAG above). So the oldest month in the
      -- window never counts, and any month whose predecessor is missing drops
      -- out as well. Measured 24 Sep 2026: Infinity's RADIANT WHITE average is
      -- 7.5 over TWO months, not three.
      --
      -- Printing "average over 3 months" beside it would claim a sample we do
      -- not have, on the very line added to make the figure auditable. Carry
      -- the count and say the true one.
      SELECT ship, part_number, AVG(u) avg3, COUNT(u) avg_months,
             MAX(CASE WHEN month = ?3 THEN u END) lastm_calc
        FROM used GROUP BY ship, part_number
    ), obpm AS (${obpm}),
    -- OBP's last-month figure over the computed one; and an item OBP reports
    -- that has no count history at all still gets a rate from OBP alone.
    agg AS (
      SELECT a0.ship, a0.part_number, a0.avg3, a0.avg_months,
             COALESCE(m.usage, a0.lastm_calc) lastm,
             CASE WHEN m.usage IS NOT NULL THEN 'obp' ELSE 'calc' END last_src
        FROM agg0 a0
        LEFT JOIN obpm m ON m.ship = a0.ship AND m.part_number = a0.part_number
      UNION ALL
      SELECT m.ship, m.part_number, NULL avg3, 0 avg_months, m.usage lastm, 'obp' last_src
        FROM obpm m
       WHERE NOT EXISTS (SELECT 1 FROM agg0 a0 WHERE a0.ship = m.ship AND a0.part_number = m.part_number)
    )
    -- Six months of counts for the floor-model rate (SIX_MONTHS above): the
    -- count at the end of ?5, every receipt after it, the count at the end of
    -- last month. Only when all seven month-end rows are on file.
    , six AS (
      SELECT ship, part_number,
             (MAX(CASE WHEN month = ?5 THEN on_hand END)
              + SUM(CASE WHEN month > ?5 THEN COALESCE(receipts, 0) ELSE 0 END)
              - MAX(CASE WHEN month = ?3 THEN on_hand END)) / ${SIX_MONTHS}.0 six_avg
        FROM consumption_snapshot
       WHERE month >= ?5 AND month <= ?3
       GROUP BY ship, part_number
      HAVING COUNT(DISTINCT month) = ${SIX_MONTHS + 1}
    )
    -- Every open line, with its Excel-serial ETA already a date. Read once.
    -- A LATE DELIVERY IS STILL A DELIVERY. A line still in the in-transit
    -- export with its ETA already past has not been received yet: it is late,
    -- or on board and not yet booked in OBP. Either way the stock is coming.
    -- This query used to keep only ETA >= today, so a late line simply
    -- vanished. Oasis, 12 Oct 2026: 40 cases of 11x17 due 11 Oct, still in
    -- transit; we told the ship to add 40 more and Ray answered "no paper
    -- order required". His own projection counts it. A late line now counts
    -- as arriving today.
    , transit AS (
      SELECT t.ship, t.part_number, t.qty,
             CASE WHEN ${src.intransit.land('t')} < ?4 THEN ?4 ELSE ${src.intransit.land('t')} END land,
             ${src.intransit.land('t')} eta
        FROM ${src.intransit.table} t
       WHERE t.snapshot_date = (SELECT MAX(snapshot_date) FROM ${src.intransit.table})
         AND ${src.intransit.etaOk('t')}
    ), nxt AS (
      SELECT ship, part_number, MIN(land) next_eta
        FROM transit WHERE land >= ?4 GROUP BY ship, part_number
    ),
    -- THE ORDER STILL OPEN. Ray Q21: after the due date the order is processed
    -- or missed, so this is the earliest due date on or after today, and the
    -- date that order is on board. Same eligibility as due.js.
    open_order AS (
      SELECT ship, due_date, loading_delivery_date, ${hasPort ? 's.loading_port' : 'NULL'} loading_port,
             ROW_NUMBER() OVER (PARTITION BY ship ORDER BY due_date, loading_delivery_date) rn
        FROM schedule_order s
       WHERE ${eligible('s')}
         AND s.due_date >= ?4
         AND s.loading_delivery_date IS NOT NULL AND s.loading_delivery_date != ''
    )
    SELECT a.ship, substr(p.description, 1, 34) item, p.description description, p.par_qty, p.brand,
           -- BOTH HALVES OF THE RULE, NOT JUST ITS ANSWER. Ray, 23 Sep 2026,
           -- chose "show both" after reading a forecast he thought was too
           -- pessimistic: the email said 11 a month for Infinity when he
           -- remembered 6. The 11 was correct and it was his own SOP — last
           -- month 11 against a 3-month average of 7 — but the email showed
           -- only the answer, so there was nothing to check it against and the
           -- disagreement cost a round trip. Carry the inputs.
           ${RATE} rate,
           a.lastm rate_last, a.avg3 rate_avg, a.avg_months rate_avg_months, a.last_src rate_source,
           z.six_avg,
           -- NULL STAYS NULL. No row, or a row with no reading, is an absence,
           -- not an empty shelf: the export writes real zeros (1,445 of 3,481
           -- rows on 16 Sep 2026), so a missing figure is never "0 on board".
           (SELECT i.on_hand FROM ${src.inventory.table} i
             WHERE i.ship = a.ship AND i.part_number = a.part_number
               AND i.snapshot_date = (SELECT MAX(snapshot_date) FROM ${src.inventory.table})
             LIMIT 1) on_hand,
           COALESCE(n.next_eta, '') next_eta,
           -- what lands for this item on THAT day - not the sum of every open
           -- line, which once made most of the fleet read "nothing to add".
           COALESCE((SELECT SUM(x.qty) FROM transit x
                      WHERE x.ship = a.ship AND x.part_number = a.part_number
                        AND x.land = n.next_eta), 0) on_next,
           -- EVERY planned landing for the item, late ones counted as today, so
           -- the stock walk sees a dry spell between two deliveries (runway.js,
           -- runsOutFirst). 'counted=qty=eta' triples: the day it is counted,
           -- the quantity, and the date OBP gave, so a late line is named as
           -- overdue rather than "arriving today".
           (SELECT GROUP_CONCAT(x.land || '=' || x.qty || '=' || x.eta, ',') FROM transit x
             WHERE x.ship = a.ship AND x.part_number = a.part_number
               AND x.land >= ?4) all_landings,
           o.due_date order_due,
           o.loading_delivery_date order_lands,
           o.loading_port order_port,
           -- where the ship loads next: a long-haul port there makes this the
           -- last order before it leaves, which takes the +4 (tonerSpare)
           ${hasPort ? `(SELECT s.loading_port FROM schedule_order s
             WHERE s.ship = a.ship AND ${eligible('s')}
               AND s.loading_delivery_date > o.loading_delivery_date
             ORDER BY s.loading_delivery_date LIMIT 1)` : 'NULL'} order_next_port,
           COALESCE((SELECT SUM(x.qty) FROM transit x
                      WHERE x.ship = a.ship AND x.part_number = a.part_number
                        AND x.land = o.loading_delivery_date), 0) on_order,
           -- the landing after the open order: next on the schedule, else the
           -- next container of anything for the ship
           COALESCE((SELECT MIN(s.loading_delivery_date) FROM schedule_order s
                      WHERE s.ship = a.ship AND ${eligible('s')}
                        AND s.loading_delivery_date > o.loading_delivery_date),
                    (SELECT MIN(x.land) FROM transit x
                      WHERE x.ship = a.ship AND x.land > o.loading_delivery_date)) order_until,
           EXISTS (SELECT 1 FROM schedule_order s
                    WHERE s.ship = a.ship AND ${eligible('s')}) has_schedule
      FROM agg a
      JOIN par p ON p.ship = a.ship AND p.part_number = a.part_number
      LEFT JOIN nxt n ON n.ship = a.ship AND n.part_number = a.part_number
      LEFT JOIN open_order o ON o.ship = a.ship AND o.rn = 1
      LEFT JOIN six z ON z.ship = a.ship AND z.part_number = a.part_number
     WHERE ${ITEM_FILTER}
       AND (${RATE} > 0 OR z.six_avg > 0)`;

  const prevMonth = monthsBack(month, 1);
  const sixFrom = monthsBack(month, SIX_MONTHS + 1);

  // The rate each item is planned on. Floor-model items take the six-month
  // figure when it exists and is positive; everything else, and a floor-model
  // item without one, takes last month (or the average) as before. An item
  // whose chosen rate is not positive is not judged, as before.
  const rows = ((await hon.prepare(sql).bind(month, fromMonth, prevMonth, today, sixFrom).all()).results || [])
    .map((r) => {
      const six = r.six_avg == null ? null : Number(r.six_avg);
      const onSix = isFloorModel(r.description) && six > 0;
      return { ...r, rate: onSix ? six : Number(r.rate) || 0, rate_six: onSix ? six : null };
    })
    .filter((r) => r.rate > 0);
  if (!rows.length) {
    return {
      ran: false, findings: [], measured: 0,
      reason: 'no ship has a measurable consumption rate for any consumable. Either the ' +
        'statistics feed has stopped or the par descriptions changed. Nothing was judged, ' +
        'which is NOT the same as no ship running out.',
    };
  }

  const findings = [];
  // Items with a measured burn but no on-hand reading. Not judged - an unknown
  // shelf is not an empty one - and named, so the night check can say so.
  const unread = [];
  for (const r of rows) {
    if (r.on_hand == null || r.on_hand === '') { unread.push({ ship: r.ship, item: r.item }); continue; }
    const arrivals = String(r.all_landings || '').split(',').filter(Boolean)
      .map((triple) => { const [date, qty, eta] = triple.split('='); return { date, qty: Number(qty) || 0, eta: eta || date }; });
    const f = runsOutFirst({
      ship: r.ship,
      item: r.item,
      onHand: Number(r.on_hand),
      rate: Number(r.rate) || 0,
      arrivals,
      today,
      nextLoading: r.next_eta || null,
      orderLands: r.order_lands || null,
      orderUntil: r.order_until || null,
      horizonDays: opts.horizonDays ?? HORIZON_DAYS,
    });
    if (f) findings.push({
      ...withQuantity({
        ...f,
        description: r.description,
        // The two inputs behind `rate`, so the email can show the rule working
        // rather than just its output. Null when the month has no reading —
        // absent is not zero, and the renderer drops the pair rather than
        // print a figure nobody measured.
        rate_last: r.rate_last == null ? null : Number(r.rate_last),
        rate_avg: r.rate_avg == null ? null : Number(r.rate_avg),
        rate_avg_months: r.rate_avg_months == null ? null : Number(r.rate_avg_months),
        rate_source: r.rate_source || 'calc',
        // Set only when the item was planned on six months (floor-model).
        rate_six: r.rate_six,
      }, {
        brand: r.brand,
        parQty: r.par_qty == null ? null : Number(r.par_qty),
        due: r.order_due || null,
        lands: r.order_lands || null,
        until: r.order_until || null,
        port: r.order_port || null,
        nextPort: r.order_next_port || null,
        coming: Number(r.on_order) || 0,
        today,
        arrivals,
      }),
      has_schedule: Boolean(Number(r.has_schedule)),
    });
  }
  // A hull with no crew aboard cannot act on any of this, and its seeded
  // inventory reads as a ship running dry. See fleetStatus.js.
  const live = findings.filter((f) => inService(f.ship, today));
  // BY DUE DATE. Miguel, 15 Sep 2026: "always filter by the due date on these
  // emails." The first tile is the deadline, so the list runs in deadline
  // order. Fleet grouping is gone from this list on purpose: the reader is told
  // what to do first, not which brand a ship belongs to.
  live.sort(byDueDate);
  const findingsOut = live;
  // The NAMES, not just the count. The fleet email's "X of Y ships clear" needs
  // to know which ships were actually looked at; without this it fell back to
  // the ships that have an ordering schedule and reported on a smaller fleet
  // than the one reading it.
  const shipNames = [...new Set(rows.map((r) => r.ship))].filter((sh) => inService(sh, today));
  return {
    ran: true, reason: null, measured: rows.length, ships: shipNames.length, shipNames, findings: findingsOut,
    unread,
    source: { inventory: src.inventory.source, intransit: src.intransit.source, consumption: haveObp ? 'obp' : 'calc' },
  };
}
