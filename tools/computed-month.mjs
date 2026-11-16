// node tools/computed-month.mjs <YYYY-MM> <open-date> <next-open-date> [out.sql]
//
// OUR OWN FIGURE FOR A MONTH, WHEN RAY'S EXPORT HAS NOT COME.
// Prints the INSERT that writes `source = 'computed'` rows into
// weekly_obp_consumption for <YYYY-MM>: the month-open count on <open-date>,
// plus what the ship accepted in the month, less the month-open count on
// <next-open-date>, LESS WHAT IT SENT TO ANOTHER SHIP (src/lib/transfers.js).
// The two dates are the month-opens step 1 of tools/README.md finds, normally
// the 1st of <YYYY-MM> and the 1st of the month after.
//
// Until 16 Nov 2026 this SQL lived in tools/README.md and did not net
// transfers. October 2026 was loaded from it on 1 Nov: Infinity TN619C read 11
// where OBP's own rule gives 7 (4 accepted by Eclipse on 14 Oct, "transfer from
// infinity"), and Ray struck the line ("Ship uses between 7-8 toners"). cims-hon
// reads this table as OBP's figure too, so the rows have to mean what OBP's
// figure means. The transfer rule lives in one place, transfers.js, and this
// tool and the Monday email both use it.
//
// A row Ray's export already wrote (source 'ray-export') is never replaced.
// A month whose figure goes negative is not written; the engine falls back to
// its own count-based figure for that item, as before.
// Nothing here touches D1. It prints SQL; a session runs it with the D1 tool.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => pathToFileURL(path.join(here, '..', 'src', 'lib', f)).href;
const { transfersOutSql } = await import(src('transfers.js'));
const { itemFilter } = await import(src('runwayDb.js'));
const { CSV_CONSUMPTION, CSV_ORDERS } = await import(src('obpSource.js'));

export function computedMonthSql(month, open, nextOpen) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) throw new Error(`month must be YYYY-MM, got ${month}`);
  for (const d of [open, nextOpen]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) throw new Error(`dates must be YYYY-MM-DD, got ${d}`);
  }
  if (!(open < nextOpen)) throw new Error(`${open} must be before ${nextOpen}`);
  const [y, m] = month.split('-').map(Number);
  const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
  const used = `b.on_hand + COALESCE(r.q, 0) - e.on_hand - COALESCE(x.qty, 0)`;
  return `INSERT OR REPLACE INTO ${CSV_CONSUMPTION}
  (ship, part_number, description, month, begin_qty, additions, end_qty, usage, source)
SELECT b.ship, b.part_number, b.description, '${month}',
       b.on_hand, COALESCE(r.q, 0), e.on_hand,
       ${used}, 'computed'
  FROM weekly_obp_month_open b
  JOIN weekly_obp_month_open e
    ON e.ship = b.ship AND e.part_number = b.part_number AND e.snapshot_date = '${nextOpen}'
  LEFT JOIN (SELECT ship, part_number, SUM(accepted_qty) q
               FROM ${CSV_ORDERS}
              WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM ${CSV_ORDERS})
                AND received_date >= '${month}-01' AND received_date < '${next}-01'
              GROUP BY ship, part_number) r
    ON r.ship = b.ship AND r.part_number = b.part_number
  LEFT JOIN (${transfersOutSql(`'${month}-01'`)}
            ) x
    ON x.ship = b.ship AND x.part_number = b.part_number AND x.month = '${month}'
 WHERE b.snapshot_date = '${open}'
   AND ${itemFilter('b')}
   AND ${used} >= 0
   AND NOT EXISTS (SELECT 1 FROM ${CSV_CONSUMPTION} z
                    WHERE z.ship = b.ship AND z.part_number = b.part_number
                      AND z.month = '${month}' AND z.source = 'ray-export');
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [month, open, nextOpen, out] = process.argv.slice(2);
  if (!month || !open || !nextOpen) {
    console.error('usage: node tools/computed-month.mjs <YYYY-MM> <open-date> <next-open-date> [out.sql]');
    process.exit(2);
  }
  const sql = computedMonthSql(month, open, nextOpen);
  if (out) { fs.writeFileSync(out, sql); console.error(`wrote ${out}`); } else process.stdout.write(sql);
}
