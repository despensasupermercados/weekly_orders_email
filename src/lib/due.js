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

// obp_intransit.eta is an EXCEL SERIAL stored in a TEXT column ('46259').
// Comparing it as a string silently matches nothing. Always convert.
export const ETA_TO_DATE = "date('1899-12-30', '+' || CAST(eta AS INTEGER) || ' days')";

export async function dueVoyages(hon, today, windowDays = WINDOW_DAYS) {
  const sql = `
    WITH monthly AS (
      SELECT ship,
             voyage,
             MIN(due_date)              AS due_date,
             MIN(loading_delivery_date) AS loading_delivery_date,
             MIN(loading_port)          AS loading_port,
             MAX(COALESCE(po_state,'')) AS po_state,
             MAX(COALESCE(date_changed,0)) AS date_changed
        FROM schedule_order
       WHERE UPPER(REPLACE(REPLACE(mot,'-',' '),'  ',' ')) LIKE 'HOTEL MONTHLY%'
          OR mot = 'AZAMARA BWS'
       GROUP BY ship, voyage
    ),
    raised AS (
      SELECT DISTINCT ship, voyage FROM (
        SELECT ship, CAST(VoyageNum AS TEXT) AS voyage FROM obp_intransit_voyage
      )
    )
    SELECT m.*,
           CAST(julianday(m.due_date) - julianday(?1) AS INT) AS days_to_due
      FROM monthly m
     WHERE m.due_date >= date(?1, '-30 day')
     ORDER BY m.due_date`;
  // obp_intransit_voyage may not exist in every environment; the caller joins
  // raised orders separately so this query stays portable.
  return (await hon.prepare(sql.replace(/\n\s+raised AS[\s\S]*?\)\n/, '\n')).bind(today).all()).results || [];
}

export async function raisedVoyages(hon) {
  const r = await hon.prepare(
    `SELECT DISTINCT voyage FROM (
       SELECT part_number AS voyage FROM obp_intransit WHERE 0
     )`
  ).all();
  return new Set((r.results || []).map((x) => x.voyage));
}

export function classify(row, raised) {
  if (row.voyage && raised.has(String(row.voyage))) return 'ORDERED';
  if (row.po_state && row.po_state !== 'none') return 'ORDERED';
  if (row.days_to_due < 0) return 'MISSED';
  if (row.days_to_due <= WINDOW_DAYS) return 'DUE NOW';
  return 'upcoming';
}
