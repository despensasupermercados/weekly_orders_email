// TONER MOVED TO ANOTHER SHIP IS NOT USAGE.
//
// Our usage arithmetic is Begin + Additions - End. OBP's own figure also
// subtracts what the ship sent to another ship (RAY-LOGIC.md 4.2; Ray, 14 Oct
// 2026: "most of the above is related to transfers, which the other ship
// accepts the order on OBP"). Until 16 Nov 2026 we treated that as something
// only Ray's export could see. It is in our own data: the RECEIVING ship
// accepts the transfer as an order line, and the crew writes the sender in its
// PO number or vendor invoice - "transfer from infinity", "transferred from
// beyond", "transfer from celebrity edge", "return from quest".
//
// Why it matters. Ray's spot check of the 16 Nov email: "Infinity TN619C CYAN
// TONER ... Incorrect consumption. Ship uses between 7-8 toners". We had
// planned on 11 for October. Eclipse accepted 4 cyan on 14 Oct, "transfer from
// infinity". 11 - 4 = 7, his number. The 4 went to Eclipse; Infinity did not
// print them.
//
// Measured before it was built, against Ray's September export (OBP's figure,
// which already nets transfers): 6 rows where OBP's usage differs from
// Begin + Additions - End. This rule explains 4 of them to the unit (Ascent
// 8.5x11, Brilliance 11x17 and 8.5x11, Constellation 11x17: 10 each). The other
// 2 are Silhouette and Millennium radiant, OBP faults with IT (4.11), not
// transfers. It flagged no row where OBP's figure equals the arithmetic.
//
// How a line is read. A line counts as sent BY a ship when its PO number or
// vendor invoice holds "from <ship>" (optionally "from celebrity <ship>" or
// "from azamara <ship>"), with the ship named as a whole word, and that ship
// is not the one receiving it. Ships are the names in `par`. A line that names
// the receiving ship itself ("Transfer from Adventure", accepted by Adventure,
// 11 Nov 2026) is not attributed to anyone: we do not guess the sender.
// The month is the month the receiver accepted it, the only date on file.

import { CSV_ORDERS } from './obpSource.js';

export const TRANSFER_COLS = ['ship', 'part_number', 'received_date', 'accepted_qty', 'po_number', 'vendor_invoice', 'snapshot_date'];

// Lower case, punctuation to spaces, padded, so " from infinity " matches
// "transfer from Infinity." and "TRANSFER FROM INFINITY/ECLIPSE" alike.
const note = (expr) => {
  let s = `LOWER(${expr})`;
  for (const ch of [',', '.', '/', '-', '(', ')', ':', ';', '#']) s = `REPLACE(${s}, '${ch}', ' ')`;
  return `' ' || ${s} || ' '`;
};

// One row per sending ship, part and month: { ship, part_number, month, qty }.
// `fromExpr` is a SQL expression for the earliest received_date to read
// ('YYYY-MM' or 'YYYY-MM-DD'; ISO strings compare in order).
export function transfersOutSql(fromExpr) {
  return `
      SELECT s.ship, o.part_number, substr(o.received_date, 1, 7) month, SUM(o.accepted_qty) qty
        FROM (SELECT ship, part_number, received_date, accepted_qty,
                     ${note("COALESCE(po_number, '') || ' ' || COALESCE(vendor_invoice, '')")} note
                FROM ${CSV_ORDERS}
               WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM ${CSV_ORDERS})
                 AND received_date >= ${fromExpr}
                 AND (LOWER(po_number) LIKE '%from%' OR LOWER(vendor_invoice) LIKE '%from%')) o
        JOIN (SELECT DISTINCT ship FROM par WHERE ship IS NOT NULL AND ship <> '') s
          ON LOWER(o.ship) <> LOWER(s.ship)
         AND (o.note LIKE '% from ' || LOWER(s.ship) || ' %'
           OR o.note LIKE '% from celebrity ' || LOWER(s.ship) || ' %'
           OR o.note LIKE '% from azamara ' || LOWER(s.ship) || ' %')
       GROUP BY s.ship, o.part_number, substr(o.received_date, 1, 7)`;
}

// The same shape with no rows, for a database that has no order lines on file.
export const NO_TRANSFERS_SQL = `SELECT NULL ship, NULL part_number, NULL month, 0 qty WHERE 0`;
