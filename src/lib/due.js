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
// CADENCE. Eligibility is not obligation. Ray, 9 Sep 2026: "the ship uses a
// bi-weekly order; if you miss one you have to wait for the other, in 2 weeks
// or so." Measured on Apex, Odyssey, Summit and Eclipse, ordered loadings sit
// 25-28 days apart - they use roughly every OTHER biweekly slot. Treating every
// eligible voyage as owed an order produced 7 false "MISSED" on a six-ship
// sample. A miss is a GAP longer than the ship's own normal interval, not
// simply an eligible voyage with no order. MAX_GAP_DAYS is deliberately loose
// so the check under-reports rather than cries wolf.

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
         -- GROUP BY A KEY THAT IS NEVER NULL.
         -- saveAzamara() writes the PO number into the voyage column, and the PO is NULL
         -- exactly when po_state = 'none' - which IS the Azamara miss signal.
         -- SQLite groups NULLs together, so GROUP BY ship, voyage collapsed
         -- every un-PO'd loading a ship had into ONE row carrying only the
         -- earliest MIN(due_date). Three missed Journey loadings arrived here
         -- as one. The miss signal was deleting its own evidence.
         -- Fall back to the loading date: for Azamara the loading IS the unit
         -- of obligation, since there is no voyage number to key on.
         COALESCE(voyage, loading_delivery_date, due_date) AS voyage_key,
         MAX(voyage)                    AS voyage,
         MIN(due_date)                  AS due_date,
         MIN(loading_delivery_date)     AS loading_delivery_date,
         MIN(loading_port)              AS loading_port,
         MAX(COALESCE(po_state, ''))    AS po_state,
         MAX(COALESCE(date_changed, 0)) AS date_changed,
         MAX(mot)                       AS mot
    FROM schedule_order
   -- NORMALISE BY REMOVING HYPHENS *AND* SPACES. Symphony's schedule carries
   -- "HOTEL BIWEEKLY - HOTEL"; replacing the hyphen with a space leaves a
   -- DOUBLE space and the LIKE fails, which made all 10 of Symphony's voyages
   -- invisible to this check. Compare the squashed string instead.
   WHERE UPPER(REPLACE(REPLACE(mot,'-',''),' ','')) LIKE 'HOTELBIWEEKLYHOTEL%'
      OR UPPER(REPLACE(REPLACE(mot,'-',''),' ','')) LIKE 'HOTELMONTHLY%'
      OR mot = 'AZAMARA BWS'
   GROUP BY ship, COALESCE(voyage, loading_delivery_date, due_date)
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

const isCovered = (r) =>
  r.mot === 'AZAMARA BWS'
    ? (Boolean(r.po_state) && r.po_state !== 'none') || r.order_lines > 0
    : r.order_lines > 0;

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
      const gapAtEntry = lastCovered ? days(r.loading_delivery_date, lastCovered) : null;
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
      } else if (!r.due_date) {
        // NO DUE DATE = NOTHING TO TELL A SHIP.
        // days_to_due is NULL when due_date is NULL, and `null <= WINDOW_DAYS`
        // is TRUE in JavaScript because null coerces to 0. This voyage used to
        // come out as DUE NOW and reach the crew as "Order due" with the date
        // rendered as an empty string - a warning with no deadline in it, which
        // hands back the "I didn't know when" answer this whole system exists
        // to remove. It is an ingest fault, so it goes to engineering.
        state = 'NO_DUE_DATE';
      } else {
        // Not ordered. Only a risk if skipping it opens a gap longer than this
        // ship normally runs between loadings.
        //
        // LOOK FORWARD AS WELL AS BACK. With no prior covered loading - the
        // first voyage in the window, or a ship whose earlier orders have all
        // been received and so are no longer in-transit - a backward-only test
        // calls every voyage at risk. Eclipse was a live false positive: no
        // order on its 28 Sep loading, but 11 lines on 9 Oct, eleven days later.
        const gap = lastCovered ? days(r.loading_delivery_date, lastCovered) : null;
        const nextCovered = list.find(
          (x) => x.loading_delivery_date > r.loading_delivery_date && isCovered(x)
        );
        const forwardGap = nextCovered
          ? days(nextCovered.loading_delivery_date, r.loading_delivery_date)
          : null;
        const coveredSoon = forwardGap !== null && forwardGap <= MAX_GAP_DAYS;
        const atRisk = coveredSoon ? false : (gap === null || gap > MAX_GAP_DAYS);
        if (!atRisk) state = 'skippable'; // the every-other-loading pattern
        else if (r.days_to_due < 0) state = 'MISSED';
        else if (r.days_to_due <= WINDOW_DAYS) state = 'DUE NOW';
        else state = 'upcoming';
      }
      out.push({
        ...r,
        state,
        // gapAtEntry, not the live `lastCovered`: an ORDERED row updates
        // lastCovered to its own loading date above, so reading it here
        // reported every ordered voyage as a zero-day gap from itself.
        gap_days: gapAtEntry,
        miss_note: missNote({ ...r, state }),
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

// Voyages the ship can do nothing about because OUR data is wrong. They must
// never reach a crew - a warning with no date in it is worse than silence - and
// they must never be silently dropped either, which is what used to happen.
export function dataFaults(rows) {
  return rows.filter((r) => r.state === 'NO_DUE_DATE');
}

// WHY it was missed, not just that it was.
//
// `miss_note` is empty on every one of the 21 missed orders in cims-order, so
// misses can be counted and never explained, and a miss you cannot explain
// cannot be prevented. Everything below is derived from the row itself - no new
// feed, no new question for Ray.
//
// This DERIVES the note. It deliberately does not write it: cims-order's rows
// belong to cims-order, and the standing guardrail is that each app manages its
// own. /misses exposes the values so a human can decide to load them.
export function missNote(r) {
  if (r.state !== 'MISSED' && r.state !== 'DUE NOW' && r.state !== 'PO_NOT_RECORDED') return null;
  const bits = [];

  if (r.state === 'PO_NOT_RECORDED') {
    bits.push(`OBP shows ${r.order_lines} order line${r.order_lines === 1 ? '' : 's'} landing on ${r.loading_delivery_date} but the MLS has no PO against it`);
    bits.push('sources disagree - a records fix, not a ship failure');
    return bits.join('; ');
  }

  const late = r.days_to_due == null ? null : -r.days_to_due;
  if (r.state === 'MISSED' && late != null) {
    bits.push(`due ${r.due_date}, ${late} day${late === 1 ? '' : 's'} past the cut-off`);
  } else if (r.due_date) {
    bits.push(`due ${r.due_date}`);
  }

  if (r.gap_days == null) {
    // No prior covered loading at all. Either the first voyage we can see, or a
    // ship whose earlier orders have all been received and left the in-transit
    // list. Worth saying, because it changes how much the gap figure is worth.
    bits.push('no earlier covered loading in view, so the gap is unmeasured');
  } else {
    bits.push(`${r.gap_days} days since the last loading with stock arriving (normal interval is 25-28)`);
  }

  if (r.date_changed) bits.push('the due date had MOVED since the previous schedule publication');
  if (r.mot === 'AZAMARA BWS') {
    bits.push(r.po_state === 'none'
      ? 'no PO on the MLS and nothing in OBP'
      : `MLS po_state is "${r.po_state}"`);
  }
  if (r.loading_port) bits.push(`loads ${r.loading_port}`);
  return bits.join('; ');
}
