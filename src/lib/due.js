// Which voyages are eligible for an order, and which of those are actually at risk.
//
// UNIT OF OBLIGATION = (ship, voyage).
//
// ELIGIBILITY. Ray, 9 Sep 2026: "For royal and celebrity we only use the
// voyages under dry dock and assigned under hotel biweekly hotel." So the
// eligible MOT is HOTEL BIWEEKLY HOTEL, NOT HOTEL MONTHLY. An earlier version
// of this file filtered on HOTEL MONTHLY% while every non-Azamara row in
// schedule_order carries HOTEL BIWEEKLY HOTEL, so ZERO Royal and Celebrity
// voyages could ever be flagged and the weekly email was silently Azamara-only
// while its header read like fleet coverage.
// Keep the MONTHLY prefix in the filter too: Eclipse and Odyssey carry
// "HOTEL MONTHLY LOCAL" and some ships still schedule against it.
//
// CADENCE. Eligibility is not obligation. Ships have a BIWEEKLY loading
// opportunity and use roughly EVERY OTHER ONE: measured on Apex, Odyssey,
// Summit and Eclipse, their ordered loadings sit 25-28 days apart. Treating
// every eligible voyage as owed an order produced 7 false "MISSED" on a
// six-ship sample. A miss is therefore a GAP longer than the ship's own normal
// interval, not simply an eligible voyage with no order.
//
// STILL OPEN WITH RAY: whether every-other-biweekly is a rule with a defined
// interval or just habit. Until he answers, MAX_GAP_DAYS is a deliberate
// over-estimate so the check under-reports rather than cries wolf.

export const WINDOW_DAYS = 7;
export const MAX_GAP_DAYS = 35;

// obp_intransit.eta is an EXCEL SERIAL IN A TEXT COLUMN ('46259'). Comparing it
// as a string silently matches nothing and produces a confident wrong answer:
// it cost a "76 lines short across 33 ships" report that was pure artefact.
// Always convert.
const ETA_TO_DATE = "date('1899-12-30', '+' || CAST(i.eta AS INTEGER) || ' days')";

// An open order's ETA equals that voyage's LOADING DELIVERY DATE. Verified on
// Summit: all 5 of its ordered future voyages match exactly, the 2 it has not
// ordered match nothing. VoyageNum would be a better key but cims-hon drops it
// at ingest, and the Azamara HOPO <-> OBP voyage mapping is still open with Ray.
const SQL = `
WITH eligible AS (
  SELECT ship,
         voyage,
         MIN(due_date)                  AS due_date,
         MIN(loading_delivery_date)     AS loading_delivery_date,
         MIN(loading_port)              AS loading_port,
         MAX(COALESCE(po_state, ''))    AS po_state,
         MAX(COALESCE(date_changed, 0)) AS date_changed,
         MAX(mot)                       AS mot
    FROM schedule_order
   WHERE UPPER(REPLACE(mot, '-', ' ')) LIKE 'HOTEL BIWEEKLY HOTEL%'
      OR UPPER(REPLACE(mot, '-', ' ')) LIKE 'HOTEL MONTHLY%'
      OR mot = 'AZAMARA BWS'
   GROUP BY ship, voyage
)
SELECT e.ship, e.voyage, e.due_date, e.loading_delivery_date, e.loading_port,
       e.po_state, e.date_changed, e.mot,
       CAST(julianday(e.due_date) - julianday(?1) AS INTEGER) AS days_to_due,
       (SELECT COUNT(*)
          FROM obp_intransit i
         WHERE i.ship = e.ship
           AND i.snapshot_date = (SELECT MAX(snapshot_date) FROM obp_intransit)
           AND ${ETA_TO_DATE} = e.loading_delivery_date) AS order_lines
  FROM eligible e
 ORDER BY e.ship, e.loading_delivery_date`;

const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

export async function voyageStates(hon, today) {
  const r = await hon.prepare(SQL).bind(today).all();
  return classifyAll(r.results || [], today);
}

// NO PO = NO ORDER. That is Ray's rule and the weekly email states it to the
// crew in as many words, so the code must not quietly invert it.
//
// For Azamara, a blank PO in Ray's hand-maintained MLS while OBP shows an order
// landing on that loading date is a DISAGREEMENT BETWEEN SOURCES, not proof of
// either. It goes to Ray as PO_NOT_RECORDED and never to the ship - chasing a
// printer who already ordered is how the email loses its authority.
export function classifyAll(rows, today) {
  const byShip = new Map();
  for (const r of rows) {
    if (!byShip.has(r.ship)) byShip.set(r.ship, []);
    byShip.get(r.ship).push(r);
  }

  const out = [];
  for (const [, list] of byShip) {
    list.sort((a, b) => (a.loading_delivery_date < b.loading_delivery_date ? -1 : 1));
    let lastCovered = null; // last loading this ship actually has stock arriving for
    for (const r of list) {
      const azamara = r.mot === 'AZAMARA BWS';
      const hasPo = Boolean(r.po_state) && r.po_state !== 'none';
      const ordered = azamara ? hasPo : r.order_lines > 0;

      let state;
      if (ordered) {
        state = 'ORDERED';
        lastCovered = r.loading_delivery_date;
      } else if (azamara && r.order_lines > 0) {
        state = 'PO_NOT_RECORDED'; // Ray's problem, not the ship's
        lastCovered = r.loading_delivery_date;
      } else if (r.loading_delivery_date < today) {
        state = 'past'; // already sailed, nothing useful to say
      } else {
        // Not ordered. Only a risk if skipping it opens a gap longer than this
        // ship normally runs between loadings.
        const gap = lastCovered ? days(r.loading_delivery_date, lastCovered) : null;
        const atRisk = gap === null || gap > MAX_GAP_DAYS;
        if (!atRisk) state = 'skippable'; // the every-other-loading pattern
        else if (r.days_to_due < 0) state = 'MISSED';
        else if (r.days_to_due <= WINDOW_DAYS) state = 'DUE NOW';
        else state = 'upcoming';
      }
      out.push({
        ...r,
        state,
        gap_days: lastCovered ? days(r.loading_delivery_date, lastCovered) : null,
      });
    }
  }
  return out.sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
}

// Goes to the ships.
export function actionable(rows) {
  return rows.filter((r) => r.state === 'MISSED' || r.state === 'DUE NOW');
}

// Goes to Ray only: the MLS and OBP disagree about whether an order exists.
// Called from /po-not-recorded so the discrepancy is surfaced, not discarded.
export function poNotRecorded(rows) {
  return rows.filter((r) => r.state === 'PO_NOT_RECORDED');
}
