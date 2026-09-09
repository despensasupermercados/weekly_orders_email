// Which voyages are due, and which have nothing raised against them.
//
// Unit of obligation = (ship, voyage). Only voyages carrying a HOTEL MONTHLY*
// row expect a CIMS order: a ship loads 4-8 times a month but raises 5-7 orders
// in six months. Treating every voyage as an obligation produces ~20 false
// alarms per ship, which teaches the crew to ignore the email.
//
// The deadline is the EARLIEST ORDER DUE DATE across that voyage's supply
// streams. A voyage carries 2-22 of them; the earliest sits a median 9-14 days
// before the hotel one, so acting on it is never late.

export const WINDOW_DAYS = 7;

// HOW WE KNOW A VOYAGE HAS AN ORDER.
//
// The cims-hon ingest keeps only 7 of the in-transit tab's 21 columns and drops
// VoyageNum, so we cannot join on the voyage code. We join on the date instead:
// an open order's ETA equals that voyage's LOADING DELIVERY DATE.
//
// Verified on Summit, 9 Sep 2026: all 5 of its ordered future voyages match
// exactly, and the 2 it has not ordered (Feb, Mar 2027) match nothing. No false
// positives, no false negatives.
//
// obp_intransit.eta is an EXCEL SERIAL IN A TEXT COLUMN ('46259'). Comparing it
// as a string silently matches nothing and produces a confident wrong answer.
// It cost us a "76 lines short across 33 ships" report that was pure artefact.
// Always convert.
const ETA_TO_DATE = "date('1899-12-30', '+' || CAST(i.eta AS INTEGER) || ' days')";

const SQL = `
WITH monthly AS (
  SELECT ship,
         voyage,
         MIN(due_date)                  AS due_date,
         MIN(loading_delivery_date)     AS loading_delivery_date,
         MIN(loading_port)              AS loading_port,
         MAX(COALESCE(po_state, ''))    AS po_state,
         MAX(COALESCE(date_changed, 0)) AS date_changed,
         MAX(mot)                       AS mot
    FROM schedule_order
   WHERE UPPER(REPLACE(mot, '-', ' ')) LIKE 'HOTEL MONTHLY%'
      OR mot = 'AZAMARA BWS'
   GROUP BY ship, voyage
)
SELECT m.ship,
       m.voyage,
       m.due_date,
       m.loading_delivery_date,
       m.loading_port,
       m.po_state,
       m.date_changed,
       m.mot,
       CAST(julianday(m.due_date) - julianday(?1) AS INTEGER) AS days_to_due,
       (SELECT COUNT(*)
          FROM obp_intransit i
         WHERE i.ship = m.ship
           AND i.snapshot_date = (SELECT MAX(snapshot_date) FROM obp_intransit)
           AND ${ETA_TO_DATE} = m.loading_delivery_date) AS order_lines
  FROM monthly m
 WHERE m.loading_delivery_date >= ?1
 ORDER BY m.due_date`;

export async function voyageStates(hon, today) {
  const r = await hon.prepare(SQL).bind(today).all();
  return (r.results || []).map((row) => ({ ...row, state: classify(row) }));
}

export function classify(row) {
  // Azamara carries its own PO state from the MLS; everyone else is judged on
  // whether an open order lands on that voyage's loading date.
  if (row.mot === 'AZAMARA BWS') {
    if (row.po_state && row.po_state !== 'none') return 'ORDERED';
  } else if (row.order_lines > 0) {
    return 'ORDERED';
  }
  if (row.days_to_due < 0) return 'MISSED';
  if (row.days_to_due <= WINDOW_DAYS) return 'DUE NOW';
  return 'upcoming';
}

// What the weekly email actually carries: anything already past its due date
// with nothing raised, plus anything falling due inside the window.
export function actionable(rows) {
  return rows
    .filter((r) => r.state === 'MISSED' || r.state === 'DUE NOW')
    .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
}
