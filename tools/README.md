# tools

Scripts a session runs by hand. None of them is deployed, and none writes to D1:
they read files and print. A person or session runs the printed SQL through the
D1 query tool on the `cims-hon` database (`7b4387c8-c611-45f8-a2e8-58061989f833`).
Only this Worker's own `weekly_*` tables are ever written that way.

| Script | What it is for |
|---|---|
| `ray-export.mjs` | Load Ray's monthly OBP export into `weekly_obp_consumption`, the usage the email plans on |
| `replay.mjs` | Re-run the Monday email's engine on saved data, to prove a rule change before it ships |
| `mast-check.sh` | Prove `src/cims-mast.js` is byte-identical to the canonical letterhead |

## The monthly usage load (first week of every month)

The email plans on LAST MONTH's usage (Ray, 12 Oct 2026), from Ray's export
when it is loaded, otherwise from our own counts. Each month:

1. **Confirm the month-open was kept.** The OBP CSV ingest copies the first
   export of each month into `weekly_obp_month_open` (`keepMonthOpen`,
   `src/lib/obpCsv.js`):
   `SELECT snapshot_date, COUNT(*), COUNT(DISTINCT ship) FROM weekly_obp_month_open WHERE substr(snapshot_date, 1, 7) = '2026-11' GROUP BY 1`
   (about 3,550 rows, 51 ships). It is normally dated the 1st. If the 1st's
   export did not arrive, it is the first day that did, say the 2nd. Use that
   date in step 3 and say so in the report. A count taken a day late carries a
   day of usage, so a few more Endings will fail to match.
2. **Find Ray's export.** It comes as three workbooks, Azamara, Royal and
   Celebrity, with one sheet per ship named by a two-letter code. His file names are loose.
   On 14 Oct he sent "Nov start OBP.xlsx", which covered 1 to 14 October.
   Put the three files in an empty folder of their own.
3. **Save the month-open as JSON**, the one AFTER the month being loaded
   (the date step 1 found):
   `SELECT ship, part_number, on_hand FROM weekly_obp_month_open WHERE snapshot_date = '2026-11-01'`.
   The D1 tool saves a large result to a file. That file can be used as it is.
4. **Run the loader:**
   `node tools/ray-export.mjs <folder> 2026-10 <month-open.json> out.sql`.
   It prints one line per sheet (`QS -> Quest (109/109 endings equal the month-open)`)
   and writes INSERT OR REPLACE statements in batches of 100.
   - It refuses, and writes nothing, when the file is not a complete month.
     A month in progress has a mid-month Ending, so no sheet matches the month-open.
   - HE (Hero, not in service) never maps. That is expected.
   - Measured 19 Oct on Ray's real files: September mapped 48 of 49 sheets and
     reproduced the 15 Oct load exactly (443 of 443 rows). The 1–14 Oct file
     mapped 0 of 49.
5. **Run each statement** through the D1 tool. Then check:
   `SELECT COUNT(*), COUNT(DISTINCT ship) FROM weekly_obp_consumption WHERE month = '2026-10'`.
   Spot-check Ascent 8.5x11 and Silhouette radiant.

**If the export has not come by the 1st**, load our own figure so Monday plans
on the month that ended. Then ask Ray for the file; when it arrives, step 4
replaces these rows (same key, source `ray-export`).
Preview with the SELECT alone, then run the whole statement. The two dates are
the month-opens step 1 finds for October and November:

```sql
INSERT OR REPLACE INTO weekly_obp_consumption
  (ship, part_number, description, month, begin_qty, additions, end_qty, usage, source)
SELECT b.ship, b.part_number, b.description, '2026-10',
       b.on_hand, COALESCE(r.q, 0), e.on_hand,
       b.on_hand + COALESCE(r.q, 0) - e.on_hand, 'computed'
  FROM weekly_obp_month_open b
  JOIN weekly_obp_month_open e
    ON e.ship = b.ship AND e.part_number = b.part_number AND e.snapshot_date = '2026-11-01'
  LEFT JOIN (SELECT ship, part_number, SUM(accepted_qty) q
               FROM weekly_obp_order
              WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM weekly_obp_order)
                AND received_date >= '2026-10-01' AND received_date < '2026-11-01'
              GROUP BY ship, part_number) r
    ON r.ship = b.ship AND r.part_number = b.part_number
 WHERE b.snapshot_date = '2026-10-01'
   AND (b.description LIKE '%TONER%' OR b.description LIKE '%PAPER%' OR b.description LIKE '%CARD STOCK%'
        OR b.description LIKE '%GLOSS%' OR b.description LIKE '%RADIANT%')
   AND b.description NOT LIKE '%FEED%' AND b.description NOT LIKE '%ROLLER%' AND b.description NOT LIKE '%KIT%'
   AND b.on_hand + COALESCE(r.q, 0) - e.on_hand >= 0;
```

This was measured on September, 19 Oct, using Ray's Beginning in place of
the 1 Sep count, which was not kept. The receipts-and-ending half equals Ray's
Usage on 401 of 420 rows. These are the 19 that differ, all known shapes
(`docs/RAY-LOGIC.md` §4):
- **Transfers out.** Ours is 10 higher: Brilliance ×2, Constellation, Ascent.
- **A transfer received.** Ours is lower: Legend cyan.
- **Receipts booked before they reach the shelf:** Spectrum, Infinity.
- **Silhouette radiant**, with OBP's IT.
- **11 Quest rows.** OBP's Additions exceed the receipts the export carries. 8
  of them go negative, so the `>= 0` line drops them. A dropped row falls back
  to the engine's own count-based figure.

Ray's export is the better source. The fallback is only a stand-in until it arrives.

## Replaying the email on saved data

```
node tools/replay.mjs <dump-dir> 2026-10-19 [out.html]
```

It loads the dumps into an in-memory SQLite and runs this repo's own
`fleetRunway()` as of that date. It prints the findings as JSON, and with
`out.html` it renders the fleet email. To test a rule change, copy the repo,
change the copy, and run the copy's `tools/replay.mjs`. Then compare the two
outputs row by row against Ray's verdicts. Count both directions: gaps he
confirms that are still listed, and rows he called okay that drop off.

Dumps are the read-only D1 results below, saved by the query tool under these
names in one folder. Large results come back as a file. Copy it in as it is.

| File | Query |
|---|---|
| `cons.json` | `SELECT c.ship, c.part_number, c.month, c.on_hand, c.receipts FROM consumption_snapshot c WHERE c.month >= '2026-03' AND c.month <= '2026-10' AND EXISTS (SELECT 1 FROM par p WHERE p.ship = c.ship AND p.part_number = c.part_number AND (p.description LIKE '%TONER%' OR p.description LIKE '%PAPER%' OR p.description LIKE '%CARD STOCK%' OR p.description LIKE '%GLOSS%' OR p.description LIKE '%RADIANT%') AND p.description NOT LIKE '%FEED%' AND p.description NOT LIKE '%ROLLER%' AND p.description NOT LIKE '%KIT%')` (split the months across two queries if the result is too large) |
| `inv.json` | `SELECT ship, part_number, description, category, on_hand, update_date, snapshot_date, source FROM weekly_obp_inventory WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM weekly_obp_inventory)` |
| `tr.json` | `SELECT ship, part_number, description, qty, po_number, vendor_invoice, voyage, port, eta_date, order_date, snapshot_date, source FROM weekly_obp_intransit WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM weekly_obp_intransit)` |
| `par.json` | `SELECT scope, ship, brand, part_number, description, category, model, par_qty, sku, source FROM par` |
| `sched.json` | `SELECT ship, voyage, mot, loading_port, loading_delivery_date, due_date, source, po_number, po_state, date_changed FROM schedule_order` |
| `obp.json` (optional) | `SELECT ship, part_number, description, month, begin_qty, additions, end_qty, usage, source FROM weekly_obp_consumption` |

Any `*.sql` file in the folder runs after the JSON is loaded. A
`ray-export.mjs` output can go straight in.

Check it on 19 Oct data: 26 findings, the same rows production mailed
("27 to fix" = 26 + 1 ship with no schedule).

Dumps are fleet data. Keep them in the session scratchpad, never in the repo.
