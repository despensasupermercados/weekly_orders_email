// The database half of the runway check. Kept apart from runway.js so the
// arithmetic stays testable without a database, which is how Ray's consumption
// formula got pinned against Onward's real figures.
//
// It resolves its columns and refuses rather than returning an empty list: an
// empty list here reads as "no ship will run out", which is the most expensive
// wrong answer this email could give.

import { inService } from './fleetStatus.js';
import { require_ } from './schema.js';
import { runsOutFirst, withQuantity, byDueDate } from './runway.js';

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

// Which schedule rows carry an order the ship can add to. The same three
// clauses as due.js and fallback.js; `t` is the schedule_order alias.
const eligible = (t) => `(
      UPPER(REPLACE(REPLACE(${t}.mot,'-',''),' ','')) LIKE 'HOTELBIWEEKLYHOTEL%'
   OR UPPER(REPLACE(REPLACE(${t}.mot,'-',''),' ','')) LIKE 'HOTELMONTHLY%'
   OR ${t}.mot = 'AZAMARA BWS')`;

export async function fleetRunway(hon, today, opts = {}) {
  for (const [table, cols] of [
    ['consumption_snapshot', ['ship', 'part_number', 'month', 'on_hand', 'receipts']],
    ['obp_inventory', ['ship', 'part_number', 'on_hand', 'snapshot_date']],
    ['obp_intransit', ['ship', 'part_number', 'eta', 'qty', 'snapshot_date']],
    ['par', ['ship', 'part_number', 'description']],
    ['schedule_order', ['ship', 'mot', 'due_date', 'loading_delivery_date']],
  ]) {
    const probe = await require_(hon, table, cols);
    if (!probe.ok) return { ran: false, reason: probe.reason, findings: [], measured: 0 };
  }

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

  // Usage per month is Ray's formula, computed in SQL because the alternative
  // is pulling three years of snapshots for 48 ships into a Worker.
  // A negative usage is a mistyped ending inventory (the Pursuit failure) and
  // is dropped here rather than allowed to drag an average down.
  const sql = `
    WITH cons AS (
      SELECT c.ship, c.part_number, c.month, c.on_hand, c.receipts,
             LAG(c.on_hand) OVER (PARTITION BY c.ship, c.part_number ORDER BY c.month) prev
        FROM consumption_snapshot c
       WHERE c.month < ?1 AND c.month >= ?2
    ), used AS (
      SELECT ship, part_number, month, (prev + receipts - on_hand) u
        FROM cons
       WHERE prev IS NOT NULL AND (prev + receipts - on_hand) >= 0
    ), agg AS (
      SELECT ship, part_number, AVG(u) avg3,
             MAX(CASE WHEN month = ?3 THEN u END) lastm
        FROM used GROUP BY ship, part_number
    )
    -- Every open line, with its Excel-serial ETA already a date. Read once.
    , transit AS (
      SELECT t.ship, t.part_number, t.qty,
             date('1899-12-30','+'||CAST(t.eta AS INTEGER)||' days') land
        FROM obp_intransit t
       WHERE t.snapshot_date = (SELECT MAX(snapshot_date) FROM obp_intransit)
         AND t.eta GLOB '[0-9]*'
    ), nxt AS (
      SELECT ship, part_number, MIN(land) next_eta
        FROM transit WHERE land >= ?4 GROUP BY ship, part_number
    ),
    -- THE ORDER STILL OPEN. Ray Q21: after the due date the order is processed
    -- or missed, so this is the earliest due date on or after today, and the
    -- date that order is on board. Same eligibility as due.js.
    open_order AS (
      SELECT ship, due_date, loading_delivery_date,
             ROW_NUMBER() OVER (PARTITION BY ship ORDER BY due_date, loading_delivery_date) rn
        FROM schedule_order s
       WHERE ${eligible('s')}
         AND s.due_date >= ?4
         AND s.loading_delivery_date IS NOT NULL AND s.loading_delivery_date != ''
    )
    SELECT a.ship, substr(p.description, 1, 34) item, p.description description, p.par_qty, p.brand,
           MAX(a.avg3, COALESCE(a.lastm, 0)) rate,
           COALESCE((SELECT i.on_hand FROM obp_inventory i
                      WHERE i.ship = a.ship AND i.part_number = a.part_number
                        AND i.snapshot_date = (SELECT MAX(snapshot_date) FROM obp_inventory)
                      LIMIT 1), 0) on_hand,
           COALESCE(n.next_eta, '') next_eta,
           -- what lands for this item on THAT day - not the sum of every open
           -- line, which once made most of the fleet read "nothing to add".
           COALESCE((SELECT SUM(x.qty) FROM transit x
                      WHERE x.ship = a.ship AND x.part_number = a.part_number
                        AND x.land = n.next_eta), 0) on_next,
           o.due_date order_due,
           o.loading_delivery_date order_lands,
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
     WHERE ${ITEM_FILTER}
       AND MAX(a.avg3, COALESCE(a.lastm, 0)) > 0`;

  const prevMonth = monthsBack(month, 1);

  const rows = (await hon.prepare(sql).bind(month, fromMonth, prevMonth, today).all()).results || [];
  if (!rows.length) {
    return {
      ran: false, findings: [], measured: 0,
      reason: 'no ship has a measurable consumption rate for any consumable. Either the ' +
        'statistics feed has stopped or the par descriptions changed. Nothing was judged, ' +
        'which is NOT the same as no ship running out.',
    };
  }

  const findings = [];
  for (const r of rows) {
    const arrivals = r.next_eta ? [{ date: r.next_eta, qty: Number(r.on_next) || 0 }] : [];
    const f = runsOutFirst({
      ship: r.ship,
      item: r.item,
      onHand: Number(r.on_hand) || 0,
      rate: Number(r.rate) || 0,
      arrivals,
      today,
      nextLoading: r.next_eta || null,
      horizonDays: opts.horizonDays ?? HORIZON_DAYS,
    });
    if (f) findings.push({
      ...withQuantity({ ...f, description: r.description }, {
        brand: r.brand,
        parQty: r.par_qty == null ? null : Number(r.par_qty),
        due: r.order_due || null,
        lands: r.order_lands || null,
        until: r.order_until || null,
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
  return { ran: true, reason: null, measured: rows.length, ships: shipNames.length, shipNames, findings: findingsOut };
}
