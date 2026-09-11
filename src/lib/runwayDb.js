// The database half of the runway check. Kept apart from runway.js so the
// arithmetic stays testable without a database, which is how Ray's consumption
// formula got pinned against Onward's real figures.
//
// It resolves its columns and refuses rather than returning an empty list: an
// empty list here reads as "no ship will run out", which is the most expensive
// wrong answer this email could give.

import { require_ } from './schema.js';
import { runsOutFirst } from './runway.js';

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

export async function fleetRunway(hon, today, opts = {}) {
  for (const [table, cols] of [
    ['consumption_snapshot', ['ship', 'part_number', 'month', 'on_hand', 'receipts']],
    ['obp_inventory', ['ship', 'part_number', 'on_hand', 'snapshot_date']],
    ['obp_intransit', ['ship', 'part_number', 'eta', 'snapshot_date']],
    ['par', ['ship', 'part_number', 'description']],
  ]) {
    const probe = await require_(hon, table, cols);
    if (!probe.ok) return { ran: false, reason: probe.reason, findings: [], measured: 0 };
  }

  const month = String(today).slice(0, 7);
  const from = new Date(Date.parse(today + 'T00:00:00Z'));
  from.setUTCMonth(from.getUTCMonth() - 4);
  const fromMonth = from.toISOString().slice(0, 7);

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
    SELECT a.ship, substr(p.description, 1, 34) item,
           MAX(a.avg3, COALESCE(a.lastm, 0)) rate,
           COALESCE((SELECT i.on_hand FROM obp_inventory i
                      WHERE i.ship = a.ship AND i.part_number = a.part_number
                        AND i.snapshot_date = (SELECT MAX(snapshot_date) FROM obp_inventory)
                      LIMIT 1), 0) on_hand,
           COALESCE((SELECT MIN(date('1899-12-30','+'||CAST(t.eta AS INTEGER)||' days'))
                       FROM obp_intransit t
                      WHERE t.ship = a.ship AND t.part_number = a.part_number
                        AND t.snapshot_date = (SELECT MAX(snapshot_date) FROM obp_intransit)
                        AND t.eta GLOB '[0-9]*'
                        AND date('1899-12-30','+'||CAST(t.eta AS INTEGER)||' days') >= ?4), '') next_eta,
           COALESCE((SELECT SUM(t.qty) FROM obp_intransit t
                      WHERE t.ship = a.ship AND t.part_number = a.part_number
                        AND t.snapshot_date = (SELECT MAX(snapshot_date) FROM obp_intransit)), 0) in_transit
      FROM agg a
      JOIN par p ON p.ship = a.ship AND p.part_number = a.part_number
     WHERE ${ITEM_FILTER}
       AND MAX(a.avg3, COALESCE(a.lastm, 0)) > 0`;

  const prevMonth = (() => {
    const d = new Date(Date.parse(today + 'T00:00:00Z'));
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  })();

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
    const f = runsOutFirst({
      ship: r.ship,
      item: r.item,
      onHand: Number(r.on_hand) || 0,
      rate: Number(r.rate) || 0,
      arrivals: r.next_eta ? [{ date: r.next_eta, qty: Number(r.in_transit) || 0 }] : [],
      today,
      nextLoading: r.next_eta || null,
      horizonDays: opts.horizonDays ?? HORIZON_DAYS,
    });
    if (f) findings.push(f);
  }
  findings.sort((a, b) => (a.stockout < b.stockout ? -1 : a.stockout > b.stockout ? 1 : 0));
  return { ran: true, reason: null, measured: rows.length, ships: new Set(rows.map((r) => r.ship)).size, findings };
}
