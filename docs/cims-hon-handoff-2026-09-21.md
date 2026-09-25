# Handoff to the cims-hon session — 21 Sep 2026

You are working in `despensasupermercados/cims-hon`. This comes from the
`weekly_orders_email` session, which reads your D1 but never writes to it and
never deploys your Worker. Everything below was measured, not assumed; the
queries are included so you can re-run them rather than trust me.

Two defects are open. One has cost us three real ship schedules; the other is
showing crews week-old stock in the handover app. There is also a contract at
the end that you must not break, and a list of things I personally got wrong
so you don't repeat them.

---

## FIRST, WHAT I GOT WRONG — so you don't inherit it

1. **I recommended wrapping your `email()` handler in try/catch to stop the 421
   bounces.** It was already wrapped (`src/worker.js`), and D1 showed 230
   inbound email rows since 23 Aug with **zero** starting with `ERROR` — the
   catch had never once fired. My "fix" was already shipped. I had reasoned
   about how Cloudflare Email Routing works instead of reading your code.
   **Read the code before you propose a change to it.**

2. **I wrote that SL = Silhouette.** Wrong. See defect 1.

3. **I told Miguel that Monday's fleet emails were computed on week-old stock.**
   Wrong. `weekly_orders_email` routes around the frozen mirror (see defect 2).
   I saw a frozen table and assumed it was the one being read.
   **Confirm which reader actually consumes a table before calling it a problem.**

The pattern in all three: asserting from a mental model instead of from the
source. Please verify my claims below the same way.

---

## DEFECT 1 — `shipCodes.js` does not know SL or AT. Three schedules were destroyed.

### What is wrong

`src/lib/shipCodes.js:58` still reads:

```
//   SL -> Silhouette? Solstice?   two fit, so SL resolves to NOTHING
```

Because SL and AT resolve to nothing, `routeAttachment` cannot map their
files to a ship and **skips them**. From `ingest_log`:

| When (UTC) | Sender | File | Outcome |
|---|---|---|---|
| 16 Sep 18:01 | `sl_printer@celebrity.com` | `Master MOT biweekly SEPT.xlsx` | skipped — SL matches no vessel |
| 16 Sep 18:13 | `at_printer@celebrity.com` | `AT biweekly mot schedule.xlsx` | skipped — AT matches no vessel |
| 16 Sep 18:42 | `at_printer@celebrity.com` | `AT biweekly mot schedule.xlsx` | skipped — AT matches no vessel |

Solstice **still has 0 rows in `schedule_order`** five days later and is the
only addressed ship in the fleet with no usable Ordering Schedule. It has been
chased twice and its crew did nothing wrong — they sent the file, we binned it.

### The answer, settled by Miguel on 21 Sep — treat as fact, do not re-derive

```
SL = SOLSTICE    sl_printer@celebrity.com
SI = SILHOUETTE  si_printer@celebrity.com
AT = ASCENT      at_printer@celebrity.com
```

The evidence that frees SL is the Silhouette specialist's own signature block:

```
James Agbada
Printer Specialist
Celebrity Silhouette | Celebrity Cruises
Office: 4408 | Mobile: 5426
SI_Printer@celebrity.com
```

SI belongs to Silhouette, so SL is uncontested and SL is Solstice.

### What to do

1. Add `SL -> Solstice`, `SI -> Silhouette`, `AT -> Ascent` to `CODES` in
   `src/lib/shipCodes.js`, and replace the line-58 comment — leaving "two fit,
   so SL resolves to NOTHING" in place will send the next reader back round
   the same loop.
2. **Re-feed the parked files.** They are already in R2 under `unparsed/`; the
   bounded re-ingest path at `src/worker.js` (the one restricted to
   `unparsed/`) exists for exactly this. **No crew needs to be contacted** —
   the files are in hand.
3. While you are in there: Miguel has an older open item listing seven
   unplaced two-letter codes — `AT, IC, IN, LE, OA, SI, SL`. Three are now
   settled above. The other four are still guesses; confirm each against its
   mailbox prefix before adding it, and add nothing you cannot evidence. A
   wrong code sends one ship's schedule to another ship's record, which is
   worse than a skip because it is silent.

### How to verify

After the re-feed, `SELECT COUNT(*) FROM schedule_order WHERE ship='Solstice'`
must be non-zero, and Ascent's row count should rise. Do not call it done on
the code change alone — the codes fix stops the *next* file being lost; only
the re-feed recovers the three already lost.

---

## DEFECT 2 — the linked workbook has been frozen for 8+ days. The HON handover app is serving stale stock.

### What is wrong

`obp_inventory` has not changed by a single unit since 14 September.

```sql
SELECT snapshot_date, COUNT(*) rows_, SUM(CAST(COALESCE(on_hand,0) AS INTEGER)) total
FROM obp_inventory GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 8;
```

Returns `3482 rows / 13990 total` for **every day 14–21 Sep**. Row-level check
on Allure confirms it is not an aggregate artifact — every part number is
identical on 14, 17 and 21 Sep. `obp_intransit` is frozen the same way.

Your watchdog has been raising `feed_frozen` critical on both since 17 Sep.
**It is correct. Do not silence it.**

### Where the freeze is — the export is fine, the workbook is not

Same source data reaches D1 by two paths:

| Total on hand | 16 Sep | 17 | 18 | 19 | 20 | 21 |
|---|---|---|---|---|---|---|
| CSV export (`weekly_obp_inventory`) | 14,253 | 14,101 | 14,056 | 14,105 | 14,285 | 14,345 |
| Linked workbook (`obp_inventory`) | 13,990 | 13,990 | 13,990 | 13,990 | 13,990 | 13,990 |

The CSVs move every night and their `update_date` advances daily. The workbook
does not move at all.

The file is at
`https://dg3365.sharepoint.com/sites/OnboardPrintAdmin/Shared Documents/General/Inventory Reporting/OBPInventoryReporting.Linked.xlsx`
and SharePoint reports `lastModified 2026-09-21T04:02:06Z` — **written today**,
two minutes after the 04:00 UTC export. So the refresh job runs and produces
stale values; the workbook's external links are not pulling. (A dead 2023 copy
sits in a personal OneDrive; ignore it.)

This is long-standing, not new. `weekly_orders_email/src/lib/obpSource.js`
records the measurement: *"between 1 Aug and 16 Sep 2026 its inventory figures
moved on five days out of forty-six, while the CSVs moved every night. On 16
Sep the mirror said Allure had 10 magenta aboard and the export said 17."*
**That stage has failed 41 days out of 46.**

### Who is actually hurt

Not the Monday fleet email — `weekly_orders_email` already reads whichever
copy is genuinely fresher and ignores the mirror.

**The HON handover app is hurt.** It reads `obp_inventory` directly, so a
Printer Specialist opening a handover right now sees stock frozen at 14
September. That is the live damage and it is yours.

### Recommendation: retire the workbook, do not refresh it

A manual refresh fixes one day. On a stage failing nine days in ten, that means
a human redoing it every morning forever. Read the CSVs directly instead —
the same move `weekly_orders_email` already made and proved.

- The CSVs are written straight from the OBP database every night at 04:00 UTC
  into SharePoint, `Inventory Reporting / Exports`.
- A working reference implementation exists in `weekly_orders_email`:
  `src/lib/obpCsv.js` (ingest, header validation, blank-quantity refusal) and
  `src/lib/obpSource.js` (choosing between copies). Read both before writing
  anything. In particular `obpSource.js` solves a trap you will hit:
  `snapshot_date` advances every morning whether or not a value changed, so a
  re-stamped frozen mirror *looks* fresh. Its `effectiveDate()` — the first
  snapshot date of the current content — is the fix.
- Two real differences to carry over: `obp_intransit.eta` is an Excel serial in
  a TEXT column while the CSV carries a real ISO date; and an absent quantity
  must stay NULL, never become 0, because 0 means "stocked out" and will tell a
  ship its press is about to stop.

Keep the mirror ingest working as a fallback. The goal is that the frozen
workbook stops being the source of truth, not that it stops arriving.

### How to verify

Run the `obp_inventory` query above for a week after the change. If the totals
move day to day and roughly track the CSV column in the table above, it is
fixed. `feed_frozen` should go quiet on its own — if you have to silence it by
hand, you have not fixed it.

---

## THE CONTRACT — do not break this, there is no test that will catch you

`weekly_orders_email` reads **your** `ingest_log` directly to decide which of
48 ships is missing an Ordering Schedule, in `src/lib/scheduleStatus.js`:

```sql
SELECT sender, ts, note FROM ingest_log
 WHERE source IN ('email', 'reingest')
   AND (lower(note) LIKE '%schedule%' OR note LIKE 'no spreadsheet attachment%')
```

and it parses the ship name out of the note text with:

```js
/→\s*([^(:→]+?)\s*\(via\b/
```

That query drives the Monday fleet email to all 48 ships and the monthly
compliance chase. **If the meaning or the wording of `source='email'` rows
changes, the fleet is silently mis-judged** — ships that sent their file get
chased, ships that did not go quiet. It would read as a crew discipline
problem for weeks. No test in either repo catches it.

So:

- Keep writing `source='email'` rows in the **existing note formats, byte for
  byte**: `"N spreadsheet(s) — <file> → <Ship> (via filename): …"`,
  `"no spreadsheet attachment; …"`, `"rejected sender (not trusted); …"`.
  Do not reword, do not add a prefix, do not change the arrow or the
  `(via …)` shape.
- New row types get a **new `source` value**, as the inbound-mail work
  correctly did with `email-received`, `inbox` and `email-reply`. Those are
  invisible to the query above, which is exactly right.
- A re-fed file writes `source='reingest'` — already in the contract, keep it.

If you genuinely need a rewording, it is a coordinated change across both
repos, not a cims-hon change.

---

## ALREADY DONE — no action, context only

The inbound-mail fix landed today and is working: `store-then-process` into
R2 `inbox/`, `email-received` receipts, the `inbox` sweeper cron, and
`email-reply` acknowledgements to senders. A test message on 21 Sep was
accepted, swept and auto-replied inside 3 minutes, and the contract above held.
Good work — that closes the class of failure where a 421 destroyed a ship's
file with no record anywhere.

Two loose ends from it, both low priority now that nothing gets destroyed:
the Worker exception log for 17 Sep ~18:10 UTC was never read, and the sender
of the second bounced message (20 Sep, queue `zOvz6Ktouqpq`) was never
identified.

---

## SUGGESTED ORDER

1. **Defect 1** — small, self-contained, and it recovers three schedules that
   are sitting in R2 right now. Solstice has been without a schedule since 16
   Sep and is being chased for our bug.
2. **Defect 2** — larger. Read `obpCsv.js` and `obpSource.js` first.

Validate by execution, not by reading: run the queries, re-feed a real file,
check the row counts actually move. And if any claim above does not reproduce,
say so — I would rather be corrected than believed.
